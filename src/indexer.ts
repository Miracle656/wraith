import "dotenv/config";
import { validateNetworkConfig, withRetry } from "./rpc";
import { parseEvents } from "./decoder";
import {
  upsertTransfers,
  upsertAccountSummaries,
  upsertNftTransfers,
  getNftMetadata,
  upsertNftMetadata,
  getLastIndexedLedger,
  setLastIndexedLedger,
  pruneOldTransfers,
} from "./db";
import { emitTransfer } from "./events";
import { parseHostFnEvent, upsertHostFnLogs, type HostFnRecord } from "./indexer/host-fn-log";
import { tagSacTransfers } from "./indexer/sac-detect";
import { pollParallel } from "./indexer/parallel";
import { isNftTransferEvent, parseNftEvents, fetchNftMetadata } from "./ingester/nft";
import { createSourceSwitcherWithConfig } from "./indexer/sources";

// ─── NFT Contract IDs ─────────────────────────────────────────────────────────
/**
 * Resolve the list of NFT contract IDs to watch.
 * Falls back to empty — NFT events can still be auto-detected by topic structure.
 */
export function resolveNftContractIds(): string[] {
  const raw = process.env.NFT_CONTRACT_IDS ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// ─── SAC Contract IDs ─────────────────────────────────────────────────────────
// The native XLM SAC address on mainnet and testnet respectively.
// These are derived from Asset.native().contractId(Networks.PUBLIC / Networks.TESTNET)
// and serve as the backwards-compatible default when SAC_CONTRACT_IDS is unset.
export const DEFAULT_XLM_SAC_MAINNET =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const DEFAULT_XLM_SAC_TESTNET =
  "CDMLFMKMMD7MWZP3FKUBZPVHTUEDLSX4BYGYKH4GCESXYHS3IHQ4EIG4";

/**
 * Resolve the list of SAC contract IDs to watch.
 *
 * Priority order:
 *  1. SAC_CONTRACT_IDS env var (comma-separated, new canonical name)
 *  2. CONTRACT_IDS env var (legacy alias — retained for backwards-compatibility)
 *  3. Default: native XLM SAC for the configured network
 *
 * The native XLM SAC default depends on STELLAR_NETWORK ("mainnet" | "testnet").
 * Any unset / empty value falls through to the next tier.
 */
export function resolveSacContractIds(): string[] {
  const raw =
    process.env.SAC_CONTRACT_IDS ||
    process.env.CONTRACT_IDS ||
    "";

  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length > 0) {
    return ids;
  }

  // Fall back to the native XLM SAC for the configured network.
  const network = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  return [
    network === "mainnet" ? DEFAULT_XLM_SAC_MAINNET : DEFAULT_XLM_SAC_TESTNET,
  ];
}

// ─── Config ───────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS  = parseInt(process.env.POLL_INTERVAL_MS    ?? "6000",  10);
const BATCH_SIZE        = parseInt(process.env.EVENTS_BATCH_SIZE   ?? "10000", 10);
const INGEST_WORKERS    = parseInt(process.env.INGEST_WORKERS      ?? "1",     10);
const SAC_CONTRACT_IDS  = resolveSacContractIds();
const NFT_CONTRACT_IDS  = resolveNftContractIds();
// Combined watch list — deduplicated so we don't request the same contract twice
const ALL_CONTRACT_IDS = [...new Set([...SAC_CONTRACT_IDS, ...NFT_CONTRACT_IDS])];
const sourceSwitcher = createSourceSwitcherWithConfig({
  horizonUrl: process.env.HORIZON_URL,
  horizonEventsPath: process.env.HORIZON_EVENTS_PATH,
  fetchImpl: (globalThis as { fetch?: (input: string, init?: unknown) => Promise<unknown> }).fetch as unknown as (
    input: string,
    init?: { headers?: Record<string, string> }
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
});

// Stellar testnet RPC retains ~7 days ≈ 120 000 ledgers (at ~5s per ledger).
// We cap the back-fill look-back so we never request a ledger that's already pruned.
const RPC_MAX_LOOKBACK_LEDGERS = 100_000;

// We leave a small buffer of ledgers behind the tip to avoid
// reading ledgers that haven't fully propagated yet.
const TIP_LAG = 2;

// ─── State ────────────────────────────────────────────────────────────────────
let startedAt = Date.now();
let totalIndexed = 0;

// Prune old data every ~1 hour (600 poll cycles × 6s = 3600s)
const PRUNE_EVERY_CYCLES = 600;
let pollCycleCount = 0;

export function getIndexerStats() {
  return {
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    totalIndexed,
  };
}

// ─── Core poll step ───────────────────────────────────────────────────────────
/**
 * Fetch one batch of events starting from `fromLedger`, parse and persist them.
 * Returns the highest ledger sequence seen in the batch (or fromLedger if empty).
 */
async function pollOnce(
  fromLedger: number,
  latestLedger: number
): Promise<number> {
  console.log(
    `[indexer] Polling ledgers ${fromLedger} → ${latestLedger} (lag: ${latestLedger - fromLedger})`
  );

  const { events, highestLedger } = await sourceSwitcher.fetchEvents(
    fromLedger, latestLedger, ALL_CONTRACT_IDS, BATCH_SIZE
  );

  if (events.length === 0) {
    await setLastIndexedLedger(highestLedger);
    return highestLedger;
  }

  // Persist token transfers
  // Split events by type: NFT (4 topics) vs fungible (3 topics)
  const fungibleEvents = events.filter((e) => !isNftTransferEvent(e));
  const nftRawEvents   = events.filter((e) => isNftTransferEvent(e));

  // ── Fungible path ────────────────────────────────────────────────────────────
  const records  = parseEvents(fungibleEvents);
  // Tag each transfer with whether its contract is a SAC (#136). Best-effort:
  // a detection failure must never block ingest, so default to false on error.
  await tagSacTransfers(records).catch((e) =>
    console.error("[indexer] SAC detection failed:", e)
  );
  const inserted = await upsertTransfers(records);
  totalIndexed  += inserted;

  // Update materialized account summaries alongside transfer inserts
  if (inserted > 0) {
    await upsertAccountSummaries(records).catch((e) =>
      console.error("[indexer] Account summary upsert failed:", e)
    );
  }

  // Broadcast each new record to WebSocket subscribers
  if (inserted > 0) {
    records.forEach(emitTransfer);
  }

  // Log every event as a raw host-fn invocation for downstream consumers (#84)
  const hostFnRecords = events
    .map(raw => { try { return parseHostFnEvent(raw); } catch { return null; } })
    .filter((r): r is HostFnRecord => r !== null);
  if (hostFnRecords.length > 0) {
    await upsertHostFnLogs(hostFnRecords).catch(err =>
      console.error("[indexer] host-fn log error:", err),
    );
  }

  // ── NFT path ─────────────────────────────────────────────────────────────────
  const nftParsed   = parseNftEvents(nftRawEvents);
  const nftRecords  = nftParsed.map((p) => p.record);
  const nftInserted = await upsertNftTransfers(nftRecords);
  totalIndexed     += nftInserted;

  // Lazy-load metadata for unique (contractId, tokenId) pairs not yet cached
  if (nftParsed.length > 0) {
    const seen = new Set<string>();
    for (const { record, tokenIdScVal } of nftParsed) {
      const key = `${record.contractId}:${record.tokenId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cached = await getNftMetadata(record.contractId, record.tokenId);
      if (!cached) {
        const meta = await fetchNftMetadata(record.contractId, tokenIdScVal).catch(() => ({}));
        await upsertNftMetadata(record.contractId, record.tokenId, meta).catch((e) =>
          console.error("[indexer] NFT metadata upsert failed:", e)
        );
      }
    }
  }

  await setLastIndexedLedger(highestLedger);

  console.log(
    `[indexer] Processed ${events.length} events → ${inserted} fungible + ${nftInserted} NFT records saved (ledger ${highestLedger})`
  );

  return highestLedger;
}

// ─── Main loop ────────────────────────────────────────────────────────────────
export async function startIndexer(): Promise<void> {
  // Fail fast if RPC is not configured — surfaces env errors before any DB work
  validateNetworkConfig();

  console.log("[indexer] Starting Wraith indexer…");
  console.log(
    `[indexer] Watching SAC contracts (${SAC_CONTRACT_IDS.length}): ${SAC_CONTRACT_IDS.join(", ")}`
  );
  if (NFT_CONTRACT_IDS.length > 0) {
    console.log(
      `[indexer] Watching NFT contracts (${NFT_CONTRACT_IDS.length}): ${NFT_CONTRACT_IDS.join(", ")}`
    );
  } else {
    console.log("[indexer] NFT auto-detection enabled (set NFT_CONTRACT_IDS for explicit watch)");
  }

  startedAt = Date.now();

  // ── Determine start ledger ──────────────────────────────────────────────────
  const latestLedger = await withRetry(() => sourceSwitcher.getLatestLedger());
  const minSafeLedger = latestLedger - RPC_MAX_LOOKBACK_LEDGERS;

  let currentLedger: number;

  const envStart = process.env.START_LEDGER ? parseInt(process.env.START_LEDGER, 10) : null;
  const dbLedger = await getLastIndexedLedger();

  if (envStart !== null && envStart > 0) {
    currentLedger = Math.max(envStart, minSafeLedger);
    console.log(`[indexer] Starting from env START_LEDGER=${envStart} (clamped to ${currentLedger})`);
  } else if (dbLedger !== null) {
    currentLedger = Math.max(dbLedger, minSafeLedger);
    console.log(`[indexer] Resuming from DB state: ledger ${dbLedger} (clamped to ${currentLedger})`);
  } else {
    // Fresh start — begin near the tip rather than trying to fetch all history.
    currentLedger = latestLedger - TIP_LAG;
    console.log(`[indexer] No prior state — starting from tip: ledger ${currentLedger}`);
  }

  // ── Polling loop ────────────────────────────────────────────────────────────
  while (true) {
    try {
      const tip = await withRetry(() => sourceSwitcher.getLatestLedger());
      const target = tip - TIP_LAG;

      if (currentLedger >= target) {
        // We're caught up — wait one poll interval
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (INGEST_WORKERS > 1 && SAC_CONTRACT_IDS.length > 1) {
        // Parallel path: shard contracts across N workers for higher throughput (#83)
        const { totalInserted, highestLedger } = await pollParallel(
          SAC_CONTRACT_IDS,
          currentLedger,
          target,
          BATCH_SIZE,
          INGEST_WORKERS,
        );
        totalIndexed += totalInserted;
        currentLedger = highestLedger;
      } else {
        currentLedger = await pollOnce(currentLedger, target);
      }

      // Periodic data retention cleanup
      pollCycleCount++;
      if (pollCycleCount >= PRUNE_EVERY_CYCLES) {
        pollCycleCount = 0;
        await pruneOldTransfers().catch((e) =>
          console.error("[indexer] Prune failed:", e)
        );
      }
    } catch (err) {
      console.error("[indexer] Unhandled error in poll loop:", err);
      // Back off before retrying to avoid hammering the RPC on persistent errors
      await sleep(POLL_INTERVAL_MS * 2);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
