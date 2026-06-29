/**
 * Tests for contract tombstones — liveness tracking + expiry detection.
 *
 * Covers the pure expiry rule, the injectable TTL fetcher / detection helpers,
 * and the idempotent insert path. No network is used — a fake TTL fetcher is
 * injected throughout — and the Prisma client is mocked for the persistence
 * tests, mirroring the sac-detect test style.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// Mock the Prisma client before importing the module under test so the
// `insertTombstones` path exercises a fake `createMany`.
const createMany = jest.fn<
  (args: { data: unknown[]; skipDuplicates: boolean }) => Promise<{ count: number }>
>();
jest.mock("../db", () => ({
  prisma: { contractTombstone: { createMany } },
}));

import {
  isExpired,
  tombstoneFor,
  fetchLiveness,
  detectExpiredContracts,
  insertTombstones,
  tombstoneExpiredContracts,
  type TtlFetcher,
  type ContractLiveness,
  type TombstoneRecord,
} from "../indexer/tombstones";

// ─── Fixture ──────────────────────────────────────────────────────────────────
// A small fleet of contracts with known TTLs, and the "current" ledger we
// evaluate them against. CALIVE is comfortably live; CEXPIRED expired one ledger
// ago; CBORDER's liveUntil equals the current ledger (still live, edge case);
// CUNKNOWN has no resolvable TTL.
const CURRENT_LEDGER = 1_000;

const TTL_FIXTURE: Record<string, number | null> = {
  CALIVE: 5_000,
  CEXPIRED: 999,
  CBORDER: 1_000,
  CUNKNOWN: null,
};

const fixtureFetcher: TtlFetcher = async (contractId) =>
  contractId in TTL_FIXTURE ? TTL_FIXTURE[contractId] : null;

beforeEach(() => {
  createMany.mockReset();
});

describe("isExpired", () => {
  it("is false while the current ledger is before liveUntil", () => {
    expect(isExpired(5_000, 1_000)).toBe(false);
  });

  it("is false on the exact liveUntil ledger (live through that ledger)", () => {
    expect(isExpired(1_000, 1_000)).toBe(false);
  });

  it("is true once the current ledger passes liveUntil", () => {
    expect(isExpired(999, 1_000)).toBe(true);
  });

  it("never treats an unknown TTL as expired", () => {
    expect(isExpired(null, 1_000)).toBe(false);
  });
});

describe("tombstoneFor", () => {
  it("returns a tombstone for an expired contract", () => {
    const liveness: ContractLiveness = { contractId: "CEXPIRED", liveUntilLedger: 999 };
    expect(tombstoneFor(liveness, CURRENT_LEDGER)).toEqual({
      contractId: "CEXPIRED",
      liveUntilLedger: 999,
      detectedLedger: CURRENT_LEDGER,
    });
  });

  it("returns null for a live contract", () => {
    expect(tombstoneFor({ contractId: "CALIVE", liveUntilLedger: 5_000 }, CURRENT_LEDGER)).toBeNull();
  });

  it("returns null when the TTL is unknown", () => {
    expect(tombstoneFor({ contractId: "CUNKNOWN", liveUntilLedger: null }, CURRENT_LEDGER)).toBeNull();
  });
});

describe("fetchLiveness", () => {
  it("resolves liveness via the injected fetcher", async () => {
    const liveness = await fetchLiveness(["CALIVE", "CEXPIRED"], fixtureFetcher);
    expect(liveness).toEqual([
      { contractId: "CALIVE", liveUntilLedger: 5_000 },
      { contractId: "CEXPIRED", liveUntilLedger: 999 },
    ]);
  });

  it("de-duplicates contract IDs so each is fetched once", async () => {
    const fetcher = jest.fn<TtlFetcher>(async () => 5_000);
    await fetchLiveness(["CA", "CA", "CB"], fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("detectExpiredContracts", () => {
  it("emits tombstones only for contracts past their liveUntil", async () => {
    const tombstones = await detectExpiredContracts(
      ["CALIVE", "CEXPIRED", "CBORDER", "CUNKNOWN"],
      CURRENT_LEDGER,
      fixtureFetcher,
    );

    expect(tombstones).toEqual([
      { contractId: "CEXPIRED", liveUntilLedger: 999, detectedLedger: CURRENT_LEDGER },
    ]);
  });

  it("returns an empty array when every contract is still live", async () => {
    const tombstones = await detectExpiredContracts(["CALIVE", "CBORDER"], CURRENT_LEDGER, fixtureFetcher);
    expect(tombstones).toEqual([]);
  });
});

describe("insertTombstones", () => {
  it("inserts on expiry detection, idempotently by contractId", async () => {
    createMany.mockResolvedValue({ count: 1 });

    const records: TombstoneRecord[] = [
      { contractId: "CEXPIRED", liveUntilLedger: 999, detectedLedger: CURRENT_LEDGER },
    ];
    const inserted = await insertTombstones(records);

    expect(inserted).toBe(1);
    expect(createMany).toHaveBeenCalledWith({ data: records, skipDuplicates: true });
  });

  it("skips the DB entirely for an empty batch", async () => {
    const inserted = await insertTombstones([]);
    expect(inserted).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe("tombstoneExpiredContracts", () => {
  it("detects expiry and persists exactly the expired contracts", async () => {
    createMany.mockResolvedValue({ count: 1 });

    const { tombstones, inserted } = await tombstoneExpiredContracts(
      ["CALIVE", "CEXPIRED", "CUNKNOWN"],
      CURRENT_LEDGER,
      fixtureFetcher,
    );

    expect(tombstones).toEqual([
      { contractId: "CEXPIRED", liveUntilLedger: 999, detectedLedger: CURRENT_LEDGER },
    ]);
    expect(inserted).toBe(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [{ contractId: "CEXPIRED", liveUntilLedger: 999, detectedLedger: CURRENT_LEDGER }],
      skipDuplicates: true,
    });
  });

  it("writes nothing when no contract has expired", async () => {
    const { tombstones, inserted } = await tombstoneExpiredContracts(
      ["CALIVE", "CBORDER"],
      CURRENT_LEDGER,
      fixtureFetcher,
    );

    expect(tombstones).toEqual([]);
    expect(inserted).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });
});
