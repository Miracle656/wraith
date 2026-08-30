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
import { emitTransfer, emitHostFnLog } from "./events";
import { parseHostFnEvent, upsertHostFnLogs, type HostFnRecord } from "./indexer/host-fn-log";
import { tagSacTransfers } from "./indexer/sac-detect";
import { pollParallel } from "./indexer/parallel";
import { isNftTransferEvent, parseNftEvents, fetchNftMetadata } from "./ingester/nft";
import { createSourceSwitcherWithConfig, type SourceSwitcher } from "./indexer/sources";
import { currentNetwork, enabledNetworks, resolveNetwork, type Network } from "./network";

// ─── NFT Contract IDs ─────────────────────────────────────────────────────────
/**
 * Resolve the list of NFT contract IDs to watch.
 * Falls back to empty — NFT events can still be auto-detected by topic structure.
 */
export function resolveNftContractIds(network?: Network): string[] {
  const suffix = resolveNetwork(network).toUpperCase();
  const raw = process.env[`NFT_CONTRACT_IDS_${suffix}`] ?? process.env.NFT_CONTRACT_IDS ?? "";
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
export function resolveSacContractIds(network?: Network): string[] {
  const net = resolveNetwork(network);
  const suffix = net.toUpperCase();

  const raw =
    process.env[`SAC_CONTRACT_IDS_${suffix}`] ||
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

  // Fall back to the native XLM SAC for *this* network, not the process-wide
  // one — with a loop per network, reading STELLAR_NETWORK here would point
  // both loops at the same chain's SAC.
  return [net === "mainnet" ? DEFAULT_XLM_SAC_MAINNET : DEFAULT_XLM_SAC_TESTNET];
}

// ─── Config ───────────────────────────────────────────────────────────────────
// These stay process-wide: they describe how hard to poll, not which chain.
const POLL_INTERVAL_MS  = parseInt(process.env.POLL_INTERVAL_MS    ?? "6000",  10);
const BATCH_SIZE        = parseInt(process.env.EVENTS_BATCH_SIZE   ?? "10000", 10);
const INGEST_WORKERS    = parseInt(process.env.INGEST_WORKERS      ?? "1",     10);

// Stellar testnet RPC retains ~7 days ≈ 120 000 ledgers (at ~5s per ledger).
// We cap the back-fill look-back so we never request a ledger that's already pruned.
const RPC_MAX_LOOKBACK_LEDGERS = 100_000;

// We leave a small buffer of ledgers behind the tip to avoid
// reading ledgers that haven't fully propagated yet.
const TIP_LAG = 2;

// Prune old data every ~1 hour (600 poll cycles × 6s = 3600s)
const PRUNE_EVERY_CYCLES = 600;

// ─── Per-network loop state ───────────────────────────────────────────────────
/**
 * Everything one indexer loop owns.
 *
 * This used to be module-level `let`s (`startedAt`, `totalIndexed`,
 * `pollCycleCount`) plus module-level watch lists and one source switcher. With
 * a loop per network that becomes a correctness problem, not a tidiness one:
 * two loops would increment the same counters, so `/status` could not say how
 * far either chain had actually got, and they would share one source switcher
 * whose failover `preferred` field is mutable — a testnet RPC outage would
 * silently repoint the mainnet loop at testnet Horizon.
 */
type LoopState = {
  network: Network;
  sacContractIds: string[];
  nftContractIds: string[];
  /** Deduplicated union — we never request the same contract twice. */
  allContractIds: string[];
  sourceSwitcher: SourceSwitcher;
  startedAt: number;
  totalIndexed: number;
  pollCycleCount: number;
};

const loops = new Map<Network, LoopState>();

/** Build the isolated state for one network's loop. */
function createLoopState(network: Network): LoopState {
  const sacContractIds = resolveSacContractIds(network);
  const nftContractIds = resolveNftContractIds(network);
  const suffix = network.toUpperCase();

  return {
    network,
    sacContractIds,
    nftContractIds,
    allContractIds: [...new Set([...sacContractIds, ...nftContractIds])],
    sourceSwitcher: createSourceSwitcherWithConfig({
      network,
      // Horizon is per-network for the same reason as RPC: one shared
      // HORIZON_URL would let a failover cross chains.
      horizonUrl: process.env[`HORIZON_URL_${suffix}`] ?? process.env.HORIZON_URL,
      horizonEventsPath: process.env.HORIZON_EVENTS_PATH,
      fetchImpl: (globalThis as { fetch?: (input: string, init?: unknown) => Promise<unknown> }).fetch as unknown as (
        input: string,
        init?: { headers?: Record<string, string> }
      ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
    }),
    startedAt: Date.now(),
    totalIndexed: 0,
    pollCycleCount: 0,
  };
}

const PROCESS_STARTED_AT = Date.now();

export type IndexerStats = {
  startedAt: string;
  uptimeSeconds: number;
  totalIndexed: number;
};

/**
 * Stats for one network. The shape is unchanged from the single-loop version so
 * existing `/status` consumers keep working; {@link getAllIndexerStats} is the
 * per-network view.
 */
export function getIndexerStats(network?: Network): IndexerStats {
  const loop = loops.get(resolveNetwork(network));
  const startedAt = loop?.startedAt ?? PROCESS_STARTED_AT;
  return {
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    totalIndexed: loop?.totalIndexed ?? 0,
  };
}

/** Stats for every running loop, keyed by network. */
export function getAllIndexerStats(): Record<string, IndexerStats & { watching: number }> {
  const out: Record<string, IndexerStats & { watching: number }> = {};
  for (const [network, loop] of loops) {
    out[network] = { ...getIndexerStats(network), watching: loop.allContractIds.length };
  }
  return out;
}

/** The networks with a loop currently running. */
export function runningNetworks(): Network[] {
  return [...loops.keys()];
}

/** Test-only: drops loop state between cases. */
export function _resetIndexerLoops(): void {
  loops.clear();
}

// ─── Core poll step ───────────────────────────────────────────────────────────
/**
 * Fetch one batch of events starting from `fromLedger`, parse and persist them.
 * Returns the highest ledger sequence seen in the batch (or fromLedger if empty).
 */
async function pollOnce(
  loop: LoopState,
  fromLedger: number,
  latestLedger: number
): Promise<number> {
  const net = loop.network;
  console.log(
    `[indexer/${net}] Polling ledgers ${fromLedger} → ${latestLedger} (lag: ${latestLedger - fromLedger})`
  );

  const { events, highestLedger } = await loop.sourceSwitcher.fetchEvents(
    fromLedger, latestLedger, loop.allContractIds, BATCH_SIZE
  );

  if (events.length === 0) {
    await setLastIndexedLedger(highestLedger, net);
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
  await tagSacTransfers(records, undefined, net).catch((e: unknown) =>
    console.error(`[indexer/${net}] SAC detection failed:`, e)
  );
  const inserted = await upsertTransfers(records, net);
  loop.totalIndexed += inserted;

  // Update materialized account summaries alongside transfer inserts
  if (inserted > 0) {
    await upsertAccountSummaries(records, net).catch((e: unknown) =>
      console.error(`[indexer/${net}] Account summary upsert failed:`, e)
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
    await upsertHostFnLogs(hostFnRecords, net).catch((err: unknown) =>
      console.error(`[indexer/${net}] host-fn log error:`, err),
    );
    hostFnRecords.forEach(emitHostFnLog);
  }

  // ── NFT path ─────────────────────────────────────────────────────────────────
  const nftParsed   = parseNftEvents(nftRawEvents);
  const nftRecords  = nftParsed.map((p) => p.record);
  const nftInserted = await upsertNftTransfers(nftRecords, net);
  loop.totalIndexed += nftInserted;

  // Lazy-load metadata for unique (contractId, tokenId) pairs not yet cached
  if (nftParsed.length > 0) {
    const seen = new Set<string>();
    for (const { record, tokenIdScVal } of nftParsed) {
      const key = `${record.contractId}:${record.tokenId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cached = await getNftMetadata(record.contractId, record.tokenId, net);
      if (!cached) {
        const meta = await fetchNftMetadata(record.contractId, tokenIdScVal, net).catch(() => ({}));
        await upsertNftMetadata(record.contractId, record.tokenId, meta, net).catch((e: unknown) =>
          console.error(`[indexer/${net}] NFT metadata upsert failed:`, e)
        );
      }
    }
  }

  await setLastIndexedLedger(highestLedger, net);

  console.log(
    `[indexer/${net}] Processed ${events.length} events → ${inserted} fungible + ${nftInserted} NFT records saved (ledger ${highestLedger})`
  );

  return highestLedger;
}

// ─── Main loop ────────────────────────────────────────────────────────────────
/**
 * Run one indexer loop for one network. Never returns.
 *
 * Each call owns its own {@link LoopState}, so two concurrent loops share no
 * mutable state: separate counters, separate watch lists, separate source
 * switchers, and separate cursors (IndexerState is keyed by network).
 */
export async function startIndexer(network?: Network): Promise<void> {
  const net = resolveNetwork(network);

  // Fail fast if RPC is not configured — surfaces env errors before any DB work
  validateNetworkConfig([net]);

  const loop = createLoopState(net);
  loops.set(net, loop);

  console.log(`[indexer/${net}] Starting Wraith indexer…`);
  console.log(
    `[indexer/${net}] Watching SAC contracts (${loop.sacContractIds.length}): ${loop.sacContractIds.join(", ")}`
  );
  if (loop.nftContractIds.length > 0) {
    console.log(
      `[indexer/${net}] Watching NFT contracts (${loop.nftContractIds.length}): ${loop.nftContractIds.join(", ")}`
    );
  } else {
    console.log(`[indexer/${net}] NFT auto-detection enabled (set NFT_CONTRACT_IDS for explicit watch)`);
  }

  // ── Determine start ledger ──────────────────────────────────────────────────
  const latestLedger = await withRetry(() => loop.sourceSwitcher.getLatestLedger());
  const minSafeLedger = latestLedger - RPC_MAX_LOOKBACK_LEDGERS;

  let currentLedger: number;

  // START_LEDGER is per-network too: the same sequence number means a
  // completely different point in history on each chain.
  const rawStart =
    process.env[`START_LEDGER_${net.toUpperCase()}`] ?? process.env.START_LEDGER;
  const envStart = rawStart ? parseInt(rawStart, 10) : null;
  const dbLedger = await getLastIndexedLedger(net);

  if (envStart !== null && envStart > 0) {
    currentLedger = Math.max(envStart, minSafeLedger);
    console.log(`[indexer/${net}] Starting from env START_LEDGER=${envStart} (clamped to ${currentLedger})`);
  } else if (dbLedger !== null) {
    currentLedger = Math.max(dbLedger, minSafeLedger);
    console.log(`[indexer/${net}] Resuming from DB state: ledger ${dbLedger} (clamped to ${currentLedger})`);
  } else {
    // Fresh start — begin near the tip rather than trying to fetch all history.
    currentLedger = latestLedger - TIP_LAG;
    console.log(`[indexer/${net}] No prior state — starting from tip: ledger ${currentLedger}`);
  }

  // ── Polling loop ────────────────────────────────────────────────────────────
  while (true) {
    try {
      const tip = await withRetry(() => loop.sourceSwitcher.getLatestLedger());
      const target = tip - TIP_LAG;

      if (currentLedger >= target) {
        // We're caught up — wait one poll interval
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (INGEST_WORKERS > 1 && loop.sacContractIds.length > 1) {
        // Parallel path: shard contracts across N workers for higher throughput (#83)
        const { totalInserted, highestLedger } = await pollParallel(
          loop.sacContractIds,
          currentLedger,
          target,
          BATCH_SIZE,
          INGEST_WORKERS,
          net,
        );
        loop.totalIndexed += totalInserted;
        currentLedger = highestLedger;
      } else {
        currentLedger = await pollOnce(loop, currentLedger, target);
      }

      // Periodic data retention cleanup
      loop.pollCycleCount++;
      if (loop.pollCycleCount >= PRUNE_EVERY_CYCLES) {
        loop.pollCycleCount = 0;
        await pruneOldTransfers(net).catch((e: unknown) =>
          console.error(`[indexer/${net}] Prune failed:`, e)
        );
      }
    } catch (err) {
      console.error(`[indexer/${net}] Unhandled error in poll loop:`, err);
      // Back off before retrying to avoid hammering the RPC on persistent errors
      await sleep(POLL_INTERVAL_MS * 2);
    }
  }
}

/**
 * Start one loop per enabled network (see `NETWORKS`).
 *
 * Loops are fault-isolated from each other: a loop that throws out of its own
 * retry handling is restarted on its own, because a mainnet RPC key expiring
 * must not stop testnet indexing. `startIndexer` never resolves, so this
 * returns immediately with the loops running in the background.
 */
export function startAllIndexers(networks: Network[] = enabledNetworks()): Network[] {
  // Validate every network up front so a bad mainnet endpoint is reported at
  // startup rather than after testnet has already begun writing.
  validateNetworkConfig(networks);

  console.log(`[indexer] Starting loops for: ${networks.join(", ")}`);

  const run = (net: Network) => {
    startIndexer(net).catch((err) => {
      console.error(`[indexer/${net}] loop crashed, restarting in 10s:`, err);
      setTimeout(() => run(net), 10_000);
    });
  };

  for (const net of networks) run(net);
  return networks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
