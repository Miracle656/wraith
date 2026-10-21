/**
 * Validate startup configuration before the service opens its listeners.
 *
 * **Only the database is required here, and that is deliberate.**
 *
 * An earlier version of this function also demanded a mainnet RPC URL whenever
 * mainnet appeared in `NETWORKS`. That took the deployed service down on
 * 2026-10-20: it runs with mainnet enabled and no `SOROBAN_RPC_URL_MAINNET`,
 * which had been fine for months, and the process then crash-looped on
 * `npm start` — build succeeded, deploy exited 1, repeatedly.
 *
 * It was fine for months because `planNetworks()` in `src/indexer.ts` already
 * handles exactly this, and the comment there explains why refusing to boot is
 * the wrong answer:
 *
 *   > an unset SOROBAN_RPC_URL_MAINNET killed the process during main(),
 *   > taking testnet indexing AND the HTTP API with it. The API does not
 *   > index. The naira rails are plain HTTP to Linq and never touch Soroban
 *   > RPC, so a missing mainnet endpoint was stopping /ngn from answering for
 *   > a reason that has nothing to do with it.
 *
 * A missing mainnet RPC skips that one indexer loop, reports it on `/status`,
 * and leaves every other network and the whole HTTP surface serving. Adding a
 * second, stricter gate in front of that undid the fix.
 *
 * So the rule for anything added here: **it belongs in this function only if
 * the process genuinely cannot do anything useful without it.** The database
 * qualifies — every route reads or writes. A per-network RPC endpoint does
 * not, because the networks are independent and the API does not index at all.
 * Anything partial belongs in `planNetworks()`, where it degrades instead of
 * refusing.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const missing = ["DATABASE_URL", "DIRECT_DATABASE_URL"].filter(
    (name) => !env[name]?.trim(),
  );

  if (missing.length > 0) {
    throw new Error(`[wraith] Missing required env vars: ${missing.join(", ")}`);
  }
}
