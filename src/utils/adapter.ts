import { getLatestBlock } from "@defillama/sdk/build/util";
import { Chain, getProvider } from "@defillama/sdk/build/general";
import { sql } from "./db";
import { getBridgeID } from "./wrappa/postgres/query";
import { insertTransactionRow, insertConfigRow } from "./wrappa/postgres/write";
import bridgeNetworks from "../data/bridgeNetworkData";
import adapters from "../adapters";
import { maxBlocksToQueryByChain } from "./constants";
import { store } from "./s3";
import { BridgeAdapter } from "../helpers/bridgeAdapter.type";
const axios = require("axios");
const retry = require("async-retry");

type RecordedBlocks = {
  [adapterDbNameChain: string]: {
    startBlock: number;
    endBlock: number;
  };
};

// FIX timeout problems throughout functions here

export const runAllAdaptersToCurrentBlock = async (
  allowNullTxValues: boolean = false,
  onConflict: "ignore" | "error" | "upsert" = "error"
) => {
  const recordedBlocks = (
    await retry(
      async (_bail: any) =>
        await axios.get(
          "https://llama-bridges-data.s3.eu-central-1.amazonaws.com/recordedBlocks.json"
        )
    )
  ).data as RecordedBlocks;
  // insert to errors db
  if (!recordedBlocks) {
    throw new Error(`Unable to retrieve recordedBlocks from s3.`);
  }

  const bridgeNetworkPromises = Promise.all(
    bridgeNetworks.map(async (bridgeNetwork) => {
      const { id, bridgeDbName } = bridgeNetwork;
      const adapter = adapters[bridgeDbName];
      // insert to errors db
      if (!adapter) {
        throw new Error(
          `Adapter for ${bridgeDbName} not found, check it is exported correctly.`
        );
      }
      await insertConfigEntriesForAdapter(adapter, bridgeDbName);
      const adapterPromises = Promise.all(
        Object.keys(adapter).map(async (chain) => {
          const chainContractsAreOn = bridgeNetwork.chainMapping?.[
            chain as Chain
          ]
            ? bridgeNetwork.chainMapping?.[chain as Chain]
            : chain;
          const { number, timestamp } = await getLatestBlock(
            chainContractsAreOn
          ); // probably need timeout here
          // insert to errors db
          if (!(number && timestamp)) {
            console.error(
              `Unable to get blocks for ${bridgeDbName} adapter on chain ${chainContractsAreOn}.`
            );
            return;
          }
          const maxBlocksToQuery = maxBlocksToQueryByChain[chainContractsAreOn]
            ? maxBlocksToQueryByChain[chainContractsAreOn]
            : maxBlocksToQueryByChain.default;
          let lastRecordedEndBlock =
            recordedBlocks[`${bridgeDbName}-${chain}`]?.endBlock;
          if (!lastRecordedEndBlock) {
            const defaultStartBlock = number - maxBlocksToQuery;
            lastRecordedEndBlock = defaultStartBlock;
            console.log(
              `Adapter for ${bridgeDbName} is missing recordedBlocks entry for chain ${chain}. Starting at block ${
                lastRecordedEndBlock + 1
              }.`
            );
          }
          try {
            await runAdapterHistorical(
              lastRecordedEndBlock + 1,
              number,
              id,
              chain as Chain,
              allowNullTxValues,
              true,
              onConflict
            );
            recordedBlocks[`${bridgeDbName}-${chain}`] =
              recordedBlocks[`${bridgeDbName}-${chain}`] || {};
            recordedBlocks[`${bridgeDbName}-${chain}`].startBlock =
              recordedBlocks[`${bridgeDbName}-${chain}`]?.startBlock ??
              lastRecordedEndBlock + 1;
            recordedBlocks[`${bridgeDbName}-${chain}`].endBlock = number;
          } catch (e) {
            // insert to errors db
            console.error(
              `Adapter txs for ${bridgeDbName} on chain ${chain} failed, skipped.`
            );
          }
        })
      );
      await adapterPromises;
    })
  );
  await bridgeNetworkPromises;
  // need better error catching
  await store("recordedBlocks.json", JSON.stringify(recordedBlocks));
  console.log("runAllAdaptersToCurrentBlock successfully ran.");
};

export const runAdapterHistorical = async (
  startBlock: number,
  endBlock: number,
  bridgeNetworkId: number,
  chain: Chain, // needed because different chains query over different block ranges
  allowNullTxValues: boolean = false,
  throwOnFailedInsert: boolean = true,
  onConflict: "ignore" | "error" | "upsert" = "error"
) => {
  const bridgeNetwork = bridgeNetworks[bridgeNetworkId - 1];
  const { bridgeDbName } = bridgeNetwork;
  const adapter = adapters[bridgeDbName];
  // insert to errors db
  if (!adapter) {
    throw new Error(
      `Adapter for ${bridgeDbName} not found, check it is exported correctly.`
    );
  }
  const adapterChainEventsFn = adapter[chain];
  // insert to errors db
  if (!adapterChainEventsFn) {
    throw new Error(`Chain ${chain} not found on adapter ${bridgeDbName}.`);
  }
  const chainContractsAreOn = bridgeNetwork.chainMapping?.[chain as Chain]
    ? bridgeNetwork.chainMapping?.[chain as Chain]
    : chain;
  const provider = getProvider(chainContractsAreOn as Chain) as any;
  // insert to errors db
  if (!provider) {
    throw new Error(`Could not get provider for chain ${chainContractsAreOn}.`);
  }
  const bridgeID = (await getBridgeID(bridgeDbName, chain))?.id;
  if (!bridgeID) {
    throw new Error(
      `${bridgeDbName} on chain ${chain} is missing in config table.`
    );
  }
  const maxBlocksToQuery = maxBlocksToQueryByChain[chainContractsAreOn]
    ? maxBlocksToQueryByChain[chainContractsAreOn]
    : maxBlocksToQueryByChain.default;
  let block = endBlock;
  console.log(`Searching for transactions for ${bridgeID} from ${block} to ${endBlock}.`)
  while (block > startBlock) {
    const startBlockForQuery = Math.max(startBlock, block - maxBlocksToQuery);
    try {
      const eventLogs = await adapterChainEventsFn(startBlockForQuery, block);
      // console.log(eventLogs);
      if (eventLogs.length === 0) {
        console.log(
          `No transactions found for ${bridgeID} from ${startBlockForQuery} to ${block}.`
        );
        return;
      }
      console.log(
        `${eventLogs.length} transactions were found for ${bridgeID} from ${startBlockForQuery} to ${block}.`
      );
      await sql.begin(async (sql) => {
        const eventLogPromises = Promise.all(
          eventLogs.map(async (log) => {
            // add timeout?
            const block = await provider.getBlock(log.blockNumber);
            const timestamp = block.timestamp * 1000;
            const { txHash, blockNumber, from, to, token, amount, isDeposit } =
              log;
            const amountString = amount.toString();
            await insertTransactionRow(
              sql,
              allowNullTxValues,
              {
                bridge_id: bridgeID,
                chain: chainContractsAreOn,
                tx_hash: txHash ?? null,
                ts: timestamp,
                tx_block: blockNumber ?? null,
                tx_from: from ?? null,
                tx_to: to ?? null,
                token: token,
                amount: amountString,
                is_deposit: isDeposit,
              },
              onConflict
            );
          })
        );
        await eventLogPromises;
      });
      console.log("finished inserting transactions")
    } catch (e) {
      // insert to errors db
      if (throwOnFailedInsert) {
        throw new Error(
          `Adapter for ${bridgeDbName} failed to get and insert logs for chain ${chain} for blocks ${startBlockForQuery}-${block}.`
        );
      }
      console.error(
        `Adapter for ${bridgeDbName} failed to get and insert logs for chain ${chain} for blocks ${startBlockForQuery}-${block}, skipping.`
      );
    }
    block = startBlockForQuery - 1;
  }
  console.log("finished inserting all transactions")
};

export const insertConfigEntriesForAdapter = async (
  adapter: BridgeAdapter,
  bridgeDbName: string
) => {
  await Object.keys(adapter).map(async (chain) => {
    const existingEntry = await getBridgeID(bridgeDbName, chain);
    if (existingEntry) {
      console.log(
        `Config already exists for ${bridgeDbName} on chain ${chain}, skipping.`
      );
      return;
    }
    await sql.begin(async (sql) => {
      await insertConfigRow(sql, { bridge_name: bridgeDbName, chain: chain });
    });
  });
};