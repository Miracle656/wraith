/**
 * The per-batch ingest pipeline, shared by every ingest path (#203).
 *
 * `pollOnce` (single fetch) and `pollParallel` (sharded fetch) used to each
 * own a copy of "what to do with events", and the parallel copy quietly
 * lacked the NFT, LP-share, host-fn-log, SAC-tagging, token-metadata and
 * account-summary steps. `INGEST_WORKERS > 1` therefore changed *what* was
 * indexed, not just how fast, with nothing erroring.
 *
 * Both paths now fetch events however they like and hand them to
 * {@link processEventBatch}. A new per-record step is added here, once, and
 * both paths get it.
 *
 * Parallel safety: the batches a parallel run processes concurrently hold
 * disjoint contracts, and every table this writes is keyed by contract
 * (`eventId` is unique per event; `AccountSummary`, `NftMetadata`,
 * `TokenMetadata` include `contractId` in their key). The one piece of shared
 * mutable state is `knownLpPools`, and a contract adds only itself to it, so
 * two partitions never race over the same entry. Nothing here is
 * parallel-unsafe.
 */

import { parseEvents } from "../decoder";
import {
  upsertTransfers,
  upsertAccountSummaries,
  upsertNftTransfers,
  getNftMetadata,
  upsertNftMetadata,
} from "../db";
import { emitTransfer, emitHostFnLog } from "../events";
import { parseHostFnEvent, upsertHostFnLogs, type HostFnRecord } from "./host-fn-log";
import { tagSacTransfers } from "./sac-detect";
import { parseLpShareEvents, upsertLpShareTransfers } from "./lp-shares";
import { enrichNftMetadata } from "./nft-metadata";
import { isNftTransferEvent, parseNftEvents, fetchNftMetadata } from "../ingester/nft";
import { getTokenMetadata } from "../tokenCache";
import { transfersStoredTotal } from "../metrics";
import type { RawEvent } from "../rpc";
import type { Network } from "../network";

export type BatchContext = {
  network: Network;
  /** Contracts established as liquidity pools; grown as new pools are seen. */
  knownLpPools: Set<string>;
};

export type BatchResult = {
  fungibleInserted: number;
  nftInserted: number;
  lpInserted: number;
};

/** Total rows newly stored by a batch, across every record type. */
export function batchTotal(r: BatchResult): number {
  return r.fungibleInserted + r.nftInserted + r.lpInserted;
}

/**
 * Parse and persist one batch of raw events: fungible transfers (with SAC
 * tagging, token metadata and account summaries), host-fn logs, LP-share
 * records and NFT transfers (with metadata).
 */
export async function processEventBatch(
  events: RawEvent[],
  ctx: BatchContext,
): Promise<BatchResult> {
  const net = ctx.network;
  const { knownLpPools } = ctx;

  // Split events by type: NFT (4 topics) vs fungible (3 topics)
  const fungibleEvents = events.filter((e) => !isNftTransferEvent(e));
  const nftRawEvents   = events.filter((e) => isNftTransferEvent(e));

  // ── Fungible path ────────────────────────────────────────────────────────────
  const records  = parseEvents(fungibleEvents);
  // Tag each transfer with whether its contract is a SAC (#136). Best-effort:
  // a detection failure must never block ingest, so default to false on error.
  await tagSacTransfers(records, undefined, net).catch((e: unknown) =>
    console.error(`[indexer/${net}] SAC detection failed:`, e)
  );
  const inserted = await upsertTransfers(records, net);

  // Resolve metadata for every distinct token in this batch. Only a cache miss
  // reaches RPC, and a miss happens once per contract for the life of the
  // database — so this is one extra call the first time a token is seen and
  // free thereafter. Best-effort: a token whose metadata cannot be read is
  // still worth indexing transfers for.
  await Promise.all(
    [...new Set(records.map((r) => r.contractId))].map((contractId) =>
      getTokenMetadata(contractId, net).catch(() => undefined)
    )
  );
  transfersStoredTotal.inc({ network: net, type: "fungible" }, inserted);

  // Update materialized account summaries alongside transfer inserts
  if (inserted > 0) {
    await upsertAccountSummaries(records, net).catch((e: unknown) =>
      console.error(`[indexer/${net}] Account summary upsert failed:`, e)
    );
  }

  // Broadcast each new record to WebSocket subscribers
  if (inserted > 0) {
    records.forEach((record) => emitTransfer(record, net));
  }

  // Log every event as a raw host-fn invocation for downstream consumers (#84)
  const hostFnRecords = events
    .map(raw => { try { return parseHostFnEvent(raw); } catch { return null; } })
    .filter((r): r is HostFnRecord => r !== null);
  if (hostFnRecords.length > 0) {
    await upsertHostFnLogs(hostFnRecords, net).catch((err: unknown) =>
      console.error(`[indexer/${net}] host-fn log error:`, err),
    );
    hostFnRecords.forEach((record) => emitHostFnLog(record, net));
  }

  // ── LP-share path ──────────────────────────────────────────────────────────
  // Decode pool deposits/withdrawals as LP-share transfers tagged with the pool
  // ID. Best-effort and additive: deposit/withdraw events are ignored by the
  // fungible path, while a pool's own share mint/burn is recorded here in
  // addition to its token-transfer row.
  const lpRecords  = parseLpShareEvents(events, knownLpPools);
  // A contract that produced an LP-share record has identified itself as a
  // pool, so its bare mint/burn counts from here on. Learning this is what lets
  // the bare dialect ever be accepted without an env allowlist.
  for (const record of lpRecords) knownLpPools.add(record.poolId);
  const lpInserted = await upsertLpShareTransfers(lpRecords, net).catch((e) => {
    console.error(`[indexer/${net}] LP-share upsert failed:`, e);
    return 0;
  });

  // ── NFT path ─────────────────────────────────────────────────────────────────
  const nftParsed   = parseNftEvents(nftRawEvents);
  const nftRecords  = nftParsed.map((p) => p.record);
  const nftInserted = await upsertNftTransfers(nftRecords, net);
  transfersStoredTotal.inc({ network: net, type: "nft" }, nftInserted);

  // Lazy-load metadata for unique (contractId, tokenId) pairs not yet cached.
  // Bounded: a small worker pool under a per-cycle time budget, so a slow or
  // dead metadata source can never hold up the cursor (#205). This lives in the
  // shared batch pipeline, so the sharded ingest path is bounded too — note the
  // budget is per batch, so a sharded run spends up to `workers` of them.
  if (nftParsed.length > 0) {
    const outcome = await enrichNftMetadata(
      nftParsed.map(({ record, tokenIdScVal }) => ({
        contractId: record.contractId,
        tokenId: record.tokenId,
        key: tokenIdScVal,
      })),
      {
        getCached: (contractId, tokenId) => getNftMetadata(contractId, tokenId, net),
        fetch: (contractId, tokenIdScVal) =>
          fetchNftMetadata(contractId, tokenIdScVal, net).catch(() => ({})),
        upsert: (contractId, tokenId, meta) => upsertNftMetadata(contractId, tokenId, meta, net),
      },
      {
        // Deliberately not logging the error object: it can carry a raw DB
        // error or a provider URL.
        onError: (message) => console.error(`[indexer/${net}] ${message}`),
      },
    );
    if (outcome.deferred > 0) {
      console.warn(
        `[indexer/${net}] NFT metadata budget spent: ${outcome.deferred} of ${outcome.unique} tokens deferred to a later cycle`,
      );
    }
  }

  return { fungibleInserted: inserted, nftInserted, lpInserted };
}
