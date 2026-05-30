/**
 * Chaos test: DB restart mid-ingest
 * ─────────────────────────────────
 * Spins up a Wraith + Postgres stack, lets the indexer ingest live testnet
 * events, pauses the DB container to simulate a crash, then resumes and
 * asserts:
 *   1. The indexer process stayed alive during the outage.
 *   2. After recovery, lastIndexedLedger advanced beyond the pre-pause value.
 *   3. No data was lost (transfer count only ever increases).
 *
 * Prerequisites: Docker + Docker Compose v2 must be available in PATH.
 * The test skips automatically when Docker is not detected.
 *
 * Run with:
 *   npm run test:chaos
 */

import { execSync, spawnSync } from "child_process";
import path from "path";

// ─── Config ───────────────────────────────────────────────────────────────────
const COMPOSE_FILE = path.resolve(__dirname, "docker-compose.chaos.yml");
const COMPOSE_CMD  = `docker compose -f "${COMPOSE_FILE}"`;
const API_BASE     = "http://localhost:3001";

// Phase 1: wait for /healthz (process alive, no DB needed)
const HEALTHZ_TIMEOUT_MS      = 60_000;  // 1 min — container start + node boot
// Phase 2: wait for first ledger indexed (DB connected + first poll done)
const FIRST_LEDGER_TIMEOUT_MS = 180_000; // 3 min — prisma push + first RPC poll
const PAUSE_DURATION_MS       = 15_000;  // DB outage window
const RECOVERY_TIMEOUT_MS     = 90_000;  // wait for indexer to advance past checkpoint
const POLL_INTERVAL_MS        = 3_000;   // polling cadence

jest.setTimeout(600_000); // 10 minutes total budget

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dockerAvailable(): boolean {
  const result = spawnSync("docker", ["info"], { stdio: "pipe" });
  return result.status === 0;
}

function exec(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson<T>(urlPath: string): Promise<T> {
  const res = await fetch(`${API_BASE}${urlPath}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${urlPath}`);
  return res.json() as Promise<T>;
}

interface StatusResponse {
  ok: boolean;
  lastIndexedLedger: number | null;
  latestLedger: number;
  totalIndexed: number;
}

/**
 * Poll fn() every POLL_INTERVAL_MS until it returns true or the deadline passes.
 */
async function waitUntil(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  description: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch {
      // transient — keep polling
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let composeStarted = false;

afterAll(async () => {
  if (!composeStarted) return;
  console.log("[chaos] Tearing down containers…");
  try {
    exec(`${COMPOSE_CMD} down --volumes --remove-orphans`);
    console.log("[chaos] Containers removed.");
  } catch (e) {
    console.error("[chaos] Cleanup failed (manual removal may be needed):", e);
  }
});

// ─── Main test ────────────────────────────────────────────────────────────────

describe("Chaos: DB restart mid-ingest", () => {
  it("indexer resumes from checkpoint with no data loss after DB pause", async () => {

    // ── 0. Skip if Docker unavailable ─────────────────────────────────────────
    if (!dockerAvailable()) {
      console.warn("[chaos] Docker not available — skipping chaos test.");
      return;
    }

    // ── 1. Start the chaos stack ───────────────────────────────────────────────
    console.log("[chaos] Building and starting containers…");
    exec(`${COMPOSE_CMD} up -d --build`);
    composeStarted = true;

    // ── 2a. Phase 1: wait for Node.js process to be alive ────────────────────
    // /healthz returns 200 as soon as the Express server is up.
    // It does NOT require a DB connection, so this completes quickly.
    console.log("[chaos] Waiting for Wraith process to boot…");
    await waitUntil(
      async () => {
        const data = await fetchJson<{ ok: boolean }>("/healthz");
        return data.ok === true;
      },
      HEALTHZ_TIMEOUT_MS,
      "/healthz returns ok=true"
    );
    console.log("[chaos] Wraith process is alive.");

    // ── 2b. Phase 2: wait for first successful DB write ───────────────────────
    // Covers: prisma db push (schema migration) + first RPC poll + first upsert.
    // We poll /status until lastIndexedLedger becomes a positive integer.
    console.log("[chaos] Waiting for first ledger to be indexed (prisma push + first poll)…");
    await waitUntil(
      async () => {
        const data = await fetchJson<StatusResponse>("/status");
        return data.lastIndexedLedger !== null && data.lastIndexedLedger > 0;
      },
      FIRST_LEDGER_TIMEOUT_MS,
      "lastIndexedLedger > 0"
    );
    console.log("[chaos] Indexer is running and has persisted at least one ledger.");

    // ── 3. Snapshot pre-pause state ───────────────────────────────────────────
    const beforeStatus = await fetchJson<StatusResponse>("/status");
    const ledgerBefore = beforeStatus.lastIndexedLedger!;
    const countBefore  = beforeStatus.totalIndexed;

    console.log(
      `[chaos] Pre-pause — lastIndexedLedger: ${ledgerBefore}, totalIndexed: ${countBefore}`
    );
    expect(ledgerBefore).toBeGreaterThan(0);

    // ── 4. Pause the DB container ─────────────────────────────────────────────
    console.log("[chaos] Pausing DB container…");
    exec("docker pause wraith_chaos_db");

    // ── 5. Hold the pause — indexer must stay alive ───────────────────────────
    console.log(`[chaos] Holding pause for ${PAUSE_DURATION_MS / 1000}s…`);
    await sleep(PAUSE_DURATION_MS);

    // Liveness probe must still respond — the Express server is independent of DB
    const liveness = await fetchJson<{ ok: boolean }>("/healthz");
    expect(liveness.ok).toBe(true);
    console.log("[chaos] Indexer process alive during DB outage ✓");

    const checkpointLedger = ledgerBefore;

    // ── 6. Resume the DB container ────────────────────────────────────────────
    console.log("[chaos] Resuming DB container…");
    exec("docker unpause wraith_chaos_db");

    // ── 7. Wait for forward progress past the checkpoint ─────────────────────
    // The indexer's withRetry loop will reconnect and resume from the saved
    // lastIndexedLedger. We wait until it advances strictly beyond the checkpoint.
    console.log("[chaos] Waiting for indexer to advance past checkpoint…");
    await waitUntil(
      async () => {
        const data = await fetchJson<StatusResponse>("/status");
        return (data.lastIndexedLedger ?? 0) > checkpointLedger;
      },
      RECOVERY_TIMEOUT_MS,
      `lastIndexedLedger > ${checkpointLedger}`
    );

    // ── 8. Final assertions ───────────────────────────────────────────────────
    const afterStatus = await fetchJson<StatusResponse>("/status");
    const ledgerAfter = afterStatus.lastIndexedLedger ?? 0;
    const countAfter  = afterStatus.totalIndexed;

    console.log(
      `[chaos] Post-recovery — lastIndexedLedger: ${ledgerAfter}, totalIndexed: ${countAfter}`
    );

    // 8a. Indexer resumed from checkpoint — did NOT reset to ledger 0
    expect(ledgerAfter).toBeGreaterThan(checkpointLedger);
    console.log(`[chaos] Checkpoint preserved: ${checkpointLedger} → ${ledgerAfter} ✓`);

    // 8b. Transfer count only increased — no data lost
    expect(countAfter).toBeGreaterThanOrEqual(countBefore);
    console.log(`[chaos] Data integrity: ${countBefore} → ${countAfter} transfers ✓`);

    // 8c. Process still healthy
    const finalHealth = await fetchJson<{ ok: boolean }>("/healthz");
    expect(finalHealth.ok).toBe(true);
    console.log("[chaos] Indexer healthy post-recovery ✓");

    console.log("[chaos] All assertions passed.");
  });
});
