/**
 * Integration test: reorg simulation + deduplication (#79)
 *
 * Validates that the ingestion layer is fully idempotent under replay
 * conditions:
 *
 *   1. Normal ingest — a batch of Horizon ledger pages is processed once.
 *   2. Replay (full duplicate) — the exact same batch is fed a second time;
 *      no new rows should be inserted.
 *   3. Skipped-ledger gap + resume — simulates a reorg where ledger N is
 *      missed on the first pass, then the range including N is replayed;
 *      only the previously-missing record should be added.
 *
 * @prisma/client is mocked at the PrismaClient constructor level so the real
 * upsertTransfers function is exercised with an in-memory dedup store that
 * mirrors the Postgres @unique(eventId) constraint.
 */

import type { TransferRecord } from "../../src/db";

// ── In-memory dedup store (declared before jest.mock hoisting) ───────────────
// Using a module-scoped object so the factory closure can reference it safely.
const _store: Map<string, TransferRecord> = new Map();
const _createManyCalls: Array<{ data: TransferRecord[]; skipDuplicates: boolean }> = [];

// ── Mock @prisma/client ───────────────────────────────────────────────────────
// By mocking the constructor we intercept the module-level `prisma` singleton
// created inside src/db.ts, which is what upsertTransfers closes over.
jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      tokenTransfer: {
        createMany: jest.fn(async (args: { data: TransferRecord[]; skipDuplicates: boolean }) => {
          _createManyCalls.push(args);

          let count = 0;
          for (const record of args.data) {
            if (!_store.has(record.eventId)) {
              _store.set(record.eventId, record);
              count++;
            }
            // Duplicate silently skipped — mirrors Postgres UNIQUE constraint
          }
          return { count };
        }),
      },
      // Silence other Prisma calls used by db module initialisation
      $queryRaw: jest.fn().mockResolvedValue([]),
      $on: jest.fn(),
    })),
    Prisma: {
      // Provide stub values for any Prisma namespace references used in db.ts
      sql: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
      join: jest.fn((arr: unknown[]) => arr),
      empty: "",
    },
  };
});

// Import AFTER the mock is registered so db.ts gets the mock PrismaClient
import { upsertTransfers } from "../../src/db";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTransfer(overrides: Partial<TransferRecord> & { eventId: string }): TransferRecord {
  return {
    contractId:     "CTEST_CONTRACT_001",
    eventType:      "transfer",
    fromAddress:    "GFROM_ADDR_AAAA",
    toAddress:      "GTO_ADDR_BBBB",
    amount:         "100000000",
    ledger:         1000,
    ledgerClosedAt: new Date("2024-06-01T00:00:00Z"),
    txHash:         "deadbeef0000",
    ...overrides,
  };
}

/**
 * Build a Horizon-style ledger page: 2 events per ledger
 * (eventIds: `<ledger>-0001`, `<ledger>-0002`).
 */
function makeLedgerPage(fromLedger: number, toLedger: number): TransferRecord[] {
  const records: TransferRecord[] = [];
  for (let ledger = fromLedger; ledger <= toLedger; ledger++) {
    records.push(
      makeTransfer({
        eventId:   `${ledger}-0001`,
        ledger,
        txHash:    `tx${ledger}a`,
      }),
      makeTransfer({
        eventId:   `${ledger}-0002`,
        ledger,
        txHash:    `tx${ledger}b`,
        eventType: "mint",
        fromAddress: null,
      })
    );
  }
  return records;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Reorg simulation — ingestion deduplication", () => {
  beforeEach(() => {
    _store.clear();
    _createManyCalls.length = 0;
  });

  // ── 1. Normal ingest ────────────────────────────────────────────────────────
  describe("normal ingest (ledgers 1–5)", () => {
    it("inserts all records on first pass", async () => {
      const page = makeLedgerPage(1, 5);
      const inserted = await upsertTransfers(page);

      expect(inserted).toBe(10); // 2 events × 5 ledgers
      expect(_store.size).toBe(10);
    });

    it("each record is stored exactly once", async () => {
      const page = makeLedgerPage(1, 5);
      await upsertTransfers(page);

      for (const record of page) {
        expect(_store.has(record.eventId)).toBe(true);
      }
    });
  });

  // ── 2. Full replay — same dataset fed twice ─────────────────────────────────
  describe("full replay (same dataset ingested twice)", () => {
    it("inserts 0 new records on the second pass", async () => {
      const page = makeLedgerPage(1, 5);
      const firstPass = await upsertTransfers(page);
      expect(firstPass).toBe(10);

      const secondPass = await upsertTransfers(page);
      expect(secondPass).toBe(0);
    });

    it("store size is unchanged after replay", async () => {
      const page = makeLedgerPage(1, 5);
      await upsertTransfers(page);
      const before = _store.size;

      await upsertTransfers(page);
      expect(_store.size).toBe(before);
    });

    it("no duplicate records exist after replay", async () => {
      const page = makeLedgerPage(1, 5);
      await upsertTransfers(page);
      await upsertTransfers(page);

      expect(_store.size).toBe(10); // exactly 10 unique events
    });
  });

  // ── 3. Skipped-ledger gap + resume ─────────────────────────────────────────
  describe("skipped-ledger gap simulation", () => {
    it("detects missing ledger after the first pass", async () => {
      // First pass: ledgers 1–3 and 5 (ledger 4 missing — simulates reorg gap)
      await upsertTransfers([...makeLedgerPage(1, 3), ...makeLedgerPage(5, 5)]);

      expect(_store.has("4-0001")).toBe(false);
      expect(_store.has("4-0002")).toBe(false);
    });

    it("backfills the missing ledger without duplicating existing records", async () => {
      await upsertTransfers([...makeLedgerPage(1, 3), ...makeLedgerPage(5, 5)]);
      const sizeAfterFirst = _store.size; // 8 records — no ledger 4

      // Resume: replay full range including the missing ledger 4
      const newlyInserted = await upsertTransfers(makeLedgerPage(1, 5));

      expect(newlyInserted).toBe(2);                   // only ledger 4's 2 events
      expect(_store.size).toBe(sizeAfterFirst + 2);    // 10 total
      expect(_store.has("4-0001")).toBe(true);
      expect(_store.has("4-0002")).toBe(true);
    });

    it("no missing data after resume — all 5 ledgers are present", async () => {
      await upsertTransfers([...makeLedgerPage(1, 3), ...makeLedgerPage(5, 5)]);
      await upsertTransfers(makeLedgerPage(1, 5));

      for (const record of makeLedgerPage(1, 5)) {
        expect(_store.has(record.eventId)).toBe(true);
      }
    });

    it("system remains consistent after aggressive overlapping replays", async () => {
      await upsertTransfers(makeLedgerPage(1, 3));
      await upsertTransfers(makeLedgerPage(3, 5)); // ledger 3 overlaps
      await upsertTransfers(makeLedgerPage(1, 5)); // full range replay

      expect(_store.size).toBe(10); // exactly 2 events × 5 ledgers — no extras
    });
  });

  // ── 4. upsertTransfers contract ────────────────────────────────────────────
  describe("upsertTransfers contract", () => {
    it("always passes skipDuplicates:true to Prisma createMany", async () => {
      await upsertTransfers(makeLedgerPage(1, 1));

      expect(_createManyCalls).toHaveLength(1);
      expect(_createManyCalls[0].skipDuplicates).toBe(true);
    });

    it("returns 0 and skips Prisma call for empty input", async () => {
      const result = await upsertTransfers([]);
      expect(result).toBe(0);
      expect(_createManyCalls).toHaveLength(0);
    });

    it("returns the count of newly inserted records", async () => {
      const inserted = await upsertTransfers(makeLedgerPage(10, 12));
      expect(inserted).toBe(6); // 2 events × 3 ledgers
    });
  });
});
