/**
 * Contract tombstones — liveness tracking for expired contract storage.
 *
 * Soroban persistent state is not permanent: every contract's instance ledger
 * entry carries a `liveUntilLedger`. Once the network's current ledger passes
 * that value the entry is archived and the contract effectively disappears —
 * its storage can no longer be read without a restore. Downstream consumers
 * that cached a contract's events need a signal that this has happened, so when
 * we observe an expiry we emit a *tombstone* row.
 *
 * Detection strategy (mirrors sac-detect's instance lookup, #136):
 *   1. Read the contract instance ledger entry (ContractData keyed by
 *      `ScVal::LedgerKeyContractInstance`) and pull its `liveUntilLedgerSeq`.
 *   2. Compare against the current ledger: expired when current > liveUntil.
 *   3. Insert one tombstone per contract, idempotently — the first detection
 *      wins; re-observing the same expiry is a no-op.
 *
 * The TTL fetcher is injectable so the detection logic can be exercised without
 * a network round-trip.
 */

import { xdr } from "@stellar/stellar-sdk";
import { getRpc } from "../rpc";
import { prisma } from "../db";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Liveness of a single contract's instance entry at a point in time.
 * `liveUntilLedger` is null when the entry has no TTL / could not be resolved.
 */
export interface ContractLiveness {
  contractId: string;
  liveUntilLedger: number | null;
}

/** A tombstone ready to be persisted. */
export interface TombstoneRecord {
  contractId: string;
  liveUntilLedger: number;
  detectedLedger: number;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * True when a contract instance has expired relative to `currentLedger`.
 *
 * An entry is live *through* its `liveUntilLedger`, so it is only expired once
 * the current ledger has moved strictly past it. A null TTL (unknown / no entry)
 * is never treated as expired — we don't tombstone on missing information.
 */
export function isExpired(
  liveUntilLedger: number | null,
  currentLedger: number,
): boolean {
  if (liveUntilLedger === null) return false;
  return currentLedger > liveUntilLedger;
}

/**
 * Build a tombstone for an expired contract, or null if it is still live (or its
 * TTL is unknown). Keeping this pure makes the expiry rule trivially testable.
 */
export function tombstoneFor(
  liveness: ContractLiveness,
  currentLedger: number,
): TombstoneRecord | null {
  if (!isExpired(liveness.liveUntilLedger, currentLedger)) return null;
  return {
    contractId: liveness.contractId,
    liveUntilLedger: liveness.liveUntilLedger as number,
    detectedLedger: currentLedger,
  };
}

// ─── TTL fetch ────────────────────────────────────────────────────────────────

/**
 * Resolve the `liveUntilLedger` of a contract's instance entry, or null if the
 * contract has no instance entry / the lookup fails. Injectable for testing.
 */
export type TtlFetcher = (contractId: string) => Promise<number | null>;

async function fetchLiveUntilLedger(contractId: string): Promise<number | null> {
  try {
    const entry = await getRpc().getContractData(
      contractId,
      xdr.ScVal.scvLedgerKeyContractInstance(),
    );
    return entry.liveUntilLedgerSeq ?? null;
  } catch {
    // Missing entry, already-evicted state, or RPC error — not determinable.
    return null;
  }
}

/**
 * Read liveness for a set of contracts, de-duplicating IDs so each unique
 * contract is looked up at most once. One RPC call per unique contract.
 */
export async function fetchLiveness(
  contractIds: Iterable<string>,
  fetchTtl: TtlFetcher = fetchLiveUntilLedger,
): Promise<ContractLiveness[]> {
  const unique = [...new Set(contractIds)];
  return Promise.all(
    unique.map(async (contractId) => ({
      contractId,
      liveUntilLedger: await fetchTtl(contractId),
    })),
  );
}

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Compute the tombstones owed for a batch of contracts at `currentLedger`,
 * fetching each one's TTL. Pure-ish: does no DB writes, so callers can inspect
 * or test the result before persisting.
 */
export async function detectExpiredContracts(
  contractIds: Iterable<string>,
  currentLedger: number,
  fetchTtl: TtlFetcher = fetchLiveUntilLedger,
): Promise<TombstoneRecord[]> {
  const liveness = await fetchLiveness(contractIds, fetchTtl);
  return liveness
    .map((l) => tombstoneFor(l, currentLedger))
    .filter((t): t is TombstoneRecord => t !== null);
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Idempotently insert tombstone rows. Conflicts on `contractId` are ignored —
 * the first expiry detection wins, so replaying a ledger range never duplicates
 * or overwrites a contract's tombstone. Returns the number of rows inserted.
 */
export async function insertTombstones(
  records: TombstoneRecord[],
): Promise<number> {
  if (records.length === 0) return 0;

  const result = await prisma.contractTombstone.createMany({
    data: records,
    skipDuplicates: true,
  });

  return result.count;
}

/**
 * Detect expired contracts at `currentLedger` and persist a tombstone for each.
 * Combines {@link detectExpiredContracts} and {@link insertTombstones}; returns
 * the records and how many were newly inserted (vs. already tombstoned).
 */
export async function tombstoneExpiredContracts(
  contractIds: Iterable<string>,
  currentLedger: number,
  fetchTtl: TtlFetcher = fetchLiveUntilLedger,
): Promise<{ tombstones: TombstoneRecord[]; inserted: number }> {
  const tombstones = await detectExpiredContracts(
    contractIds,
    currentLedger,
    fetchTtl,
  );
  const inserted = await insertTombstones(tombstones);

  if (inserted > 0) {
    console.log(
      `[tombstone] ${inserted} contract(s) tombstoned at ledger ${currentLedger}`,
    );
  }

  return { tombstones, inserted };
}
