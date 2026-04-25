import "dotenv/config";
import { fetchEventsSafe, getLatestLedger, withRetry, validateNetworkConfig } from "./rpc";
import { parseEvents } from "./decoder";
import {
  upsertTransfers,
  getLastIndexedLedger,
  setLastIndexedLedger,
  pruneOldTransfers,
} from "./db";
import { emitTransfer } from "./events";
import { initTokenCache, getTokenMetadata } from "./tokenCache";

// ─── Config ───────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "6000", 10);
const BATCH_SIZE = parseInt(process.env.EVENTS_BATCH_SIZE ?? "10000", 10);
const CONTRACT_IDS = (process.env.CONTRACT_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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

  // fetchEventsSafe bisects on XDR decode errors so newer protocol ledgers
  // don't crash the whole indexer — they're skipped with a warning instead.
  const { events, highestLedger } = await fetchEventsSafe(
    fromLedger, latestLedger, CONTRACT_IDS, BATCH_SIZE
  );

  if (events.length === 0) {
    await setLastIndexedLedger(highestLedger);
    return highestLedger;
  }

  // Parse
  const records = parseEvents(events);

  // Persist
  const inserted = await upsertTransfers(records);
  totalIndexed += inserted;

  // Broadcast each new record to WebSocket subscribers
  if (inserted > 0) {
    records.forEach(emitTransfer);
  }

  // Warm the token metadata cache for any new contracts seen in this batch.
  // This ensures that metadata is available for API consumers immediately.
  const uniqueContracts = [...new Set(records.map((r) => r.contractId))];
  await Promise.all(
    uniqueContracts.map((id) =>
      getTokenMetadata(id).catch((e) =>
        console.warn(`[indexer] Could not resolve metadata for ${id}:`, e.message)
      )
    )
  );

  await setLastIndexedLedger(highestLedger);

  console.log(
    `[indexer] Processed ${events.length} events → ${inserted} new records saved (ledger ${highestLedger})`
  );

  return highestLedger;
}

// ─── Main loop ────────────────────────────────────────────────────────────────
export async function startIndexer(): Promise<void> {
  // Fail fast if RPC is not configured — surfaces env errors before any DB work
  validateNetworkConfig();

  // Load existing metadata from DB into memory
  await initTokenCache();

  console.log("[indexer] Starting Wraith indexer…");
  console.log(
    `[indexer] Watching contracts: ${CONTRACT_IDS.length > 0 ? CONTRACT_IDS.join(", ") : "ALL"}`
  );

  startedAt = Date.now();

  // ── Determine start ledger ──────────────────────────────────────────────────
  const latestLedger = await withRetry(getLatestLedger);
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
      const tip = await withRetry(getLatestLedger);
      const target = tip - TIP_LAG;

      if (currentLedger >= target) {
        // We're caught up — wait one poll interval
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      currentLedger = await pollOnce(currentLedger, target);

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
