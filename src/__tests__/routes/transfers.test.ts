import request from "supertest";
import { createApp } from "../../api";

// ── Module mocks must be declared before any imports that use them ──────────
jest.mock("../../db", () => ({
  queryTransfers: jest.fn(),
  queryAllTransfers: jest.fn(),
  queryByTxHash: jest.fn(),
  querySummary: jest.fn(),
  getLastIndexedLedger: jest.fn(),
  prisma: { $queryRaw: jest.fn() },
}));

jest.mock("../../rpc", () => ({
  getLatestLedger: jest.fn(),
}));

jest.mock("../../indexer", () => ({
  getIndexerStats: jest
    .fn()
    .mockReturnValue({ startedAt: "2024-01-01T00:00:00.000Z", uptimeSeconds: 0, totalIndexed: 0 }),
}));

import { queryTransfers, queryAllTransfers, queryByTxHash, querySummary, getLastIndexedLedger } from "../../db";
import { getLatestLedger } from "../../rpc";

// ── Typed mock helpers ────────────────────────────────────────────────────────
const mockQueryTransfers = queryTransfers as jest.MockedFunction<typeof queryTransfers>;
const mockQueryAllTransfers = queryAllTransfers as jest.MockedFunction<typeof queryAllTransfers>;
const mockQueryByTxHash = queryByTxHash as jest.MockedFunction<typeof queryByTxHash>;
const mockQuerySummary = querySummary as jest.MockedFunction<typeof querySummary>;
const mockGetLastIndexedLedger = getLastIndexedLedger as jest.MockedFunction<typeof getLastIndexedLedger>;
const mockGetLatestLedger = getLatestLedger as jest.MockedFunction<typeof getLatestLedger>;

// ── Seed data factory ─────────────────────────────────────────────────────────
const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM";

const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const BOB   = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWWHF";
const CAROL = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWWHF";

type TransferOverrides = Partial<Omit<ReturnType<typeof baseTransfer>, "fromAddress" | "toAddress">> & {
  fromAddress?: string | null;
  toAddress?: string | null;
};

function makeTransfer(overrides: TransferOverrides = {}) {
  return { ...baseTransfer(), ...overrides };
}

function baseTransfer() {
  return {
    id: 1,
    contractId: CONTRACT_A,
    eventType: "transfer",
    fromAddress: BOB,
    toAddress: ALICE,
    amount: "10000000000",        // 1000.0000000 tokens
    ledger: 1000,
    ledgerClosedAt: new Date("2025-01-01T00:00:00Z"),
    txHash: "aaaa1111",
    eventId: "evt-001",
    createdAt: new Date("2025-01-01T00:00:01Z"),
  };
}

// 20 seeded transfers covering diverse scenarios
const SEED_TRANSFERS = [
  // Incoming to ALICE from BOB — CONTRACT_A
  makeTransfer({ id: 1, eventId: "e-001", fromAddress: BOB, toAddress: ALICE, contractId: CONTRACT_A, ledger: 1001, amount: "10000000" }),
  makeTransfer({ id: 2, eventId: "e-002", fromAddress: BOB, toAddress: ALICE, contractId: CONTRACT_A, ledger: 1002, amount: "20000000" }),
  makeTransfer({ id: 3, eventId: "e-003", fromAddress: BOB, toAddress: ALICE, contractId: CONTRACT_A, ledger: 1003, amount: "30000000", ledgerClosedAt: new Date("2025-02-01T00:00:00Z") }),
  makeTransfer({ id: 4, eventId: "e-004", fromAddress: BOB, toAddress: ALICE, contractId: CONTRACT_B, ledger: 1004, amount: "40000000" }),
  makeTransfer({ id: 5, eventId: "e-005", fromAddress: CAROL, toAddress: ALICE, contractId: CONTRACT_B, ledger: 1005, amount: "50000000" }),
  // Incoming to ALICE — mint events
  makeTransfer({ id: 6, eventId: "e-006", fromAddress: null, toAddress: ALICE, contractId: CONTRACT_A, eventType: "mint", ledger: 1006, amount: "60000000" }),
  makeTransfer({ id: 7, eventId: "e-007", fromAddress: null, toAddress: ALICE, contractId: CONTRACT_B, eventType: "mint", ledger: 1007, amount: "70000000" }),
  // Outgoing from ALICE to BOB — CONTRACT_A
  makeTransfer({ id: 8, eventId: "e-008", fromAddress: ALICE, toAddress: BOB, contractId: CONTRACT_A, ledger: 1008, amount: "80000000" }),
  makeTransfer({ id: 9, eventId: "e-009", fromAddress: ALICE, toAddress: BOB, contractId: CONTRACT_A, ledger: 1009, amount: "90000000" }),
  makeTransfer({ id: 10, eventId: "e-010", fromAddress: ALICE, toAddress: CAROL, contractId: CONTRACT_B, ledger: 1010, amount: "100000000" }),
  // Outgoing from ALICE — burn events
  makeTransfer({ id: 11, eventId: "e-011", fromAddress: ALICE, toAddress: null, contractId: CONTRACT_A, eventType: "burn", ledger: 1011, amount: "110000000" }),
  // BOB ↔ CAROL transfers (unrelated to ALICE)
  makeTransfer({ id: 12, eventId: "e-012", fromAddress: BOB, toAddress: CAROL, contractId: CONTRACT_A, ledger: 1012, amount: "120000000" }),
  makeTransfer({ id: 13, eventId: "e-013", fromAddress: CAROL, toAddress: BOB, contractId: CONTRACT_B, ledger: 1013, amount: "130000000" }),
  // More ALICE transfers on CONTRACT_A at later timestamps
  makeTransfer({ id: 14, eventId: "e-014", fromAddress: BOB, toAddress: ALICE, contractId: CONTRACT_A, ledger: 1014, amount: "140000000", ledgerClosedAt: new Date("2025-03-01T00:00:00Z") }),
  makeTransfer({ id: 15, eventId: "e-015", fromAddress: BOB, toAddress: ALICE, contractId: CONTRACT_A, ledger: 1015, amount: "150000000", ledgerClosedAt: new Date("2025-03-15T00:00:00Z") }),
  makeTransfer({ id: 16, eventId: "e-016", fromAddress: ALICE, toAddress: BOB, contractId: CONTRACT_A, ledger: 1016, amount: "160000000", ledgerClosedAt: new Date("2025-04-01T00:00:00Z") }),
  makeTransfer({ id: 17, eventId: "e-017", fromAddress: ALICE, toAddress: BOB, contractId: CONTRACT_A, ledger: 1017, amount: "170000000", ledgerClosedAt: new Date("2025-04-15T00:00:00Z") }),
  // clawback events
  makeTransfer({ id: 18, eventId: "e-018", fromAddress: ALICE, toAddress: null, contractId: CONTRACT_B, eventType: "clawback", ledger: 1018, amount: "180000000" }),
  // Same txHash group for tx tests
  makeTransfer({ id: 19, eventId: "e-019", fromAddress: BOB, toAddress: ALICE, contractId: CONTRACT_A, txHash: "txhash-multi", ledger: 1019, amount: "190000000" }),
  makeTransfer({ id: 20, eventId: "e-020", fromAddress: CAROL, toAddress: ALICE, contractId: CONTRACT_B, txHash: "txhash-multi", ledger: 1019, amount: "200000000" }),
];

// ─────────────────────────────────────────────────────────────────────────────

describe("Transfer route handlers", () => {
  const app = createApp();

  beforeEach(() => {
    // Default mocks for status/readyz side-effects
    mockGetLastIndexedLedger.mockResolvedValue(1020);
    mockGetLatestLedger.mockResolvedValue(1022);
  });

  // ── /transfers/incoming/:address ───────────────────────────────────────────
  describe("GET /transfers/incoming/:address", () => {
    it("returns all incoming transfers for a known address", async () => {
      const incoming = SEED_TRANSFERS.filter((t) => t.toAddress === ALICE);
      mockQueryTransfers.mockResolvedValue({ total: incoming.length, transfers: incoming });

      const res = await request(app).get(`/transfers/incoming/${ALICE}`);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(incoming.length);
      expect(res.body.transfers).toHaveLength(incoming.length);
      expect(res.body.limit).toBe(50);
      expect(res.body.offset).toBe(0);
    });

    it("attaches displayAmount to every transfer", async () => {
      const transfer = makeTransfer({ amount: "10000000" });
      mockQueryTransfers.mockResolvedValue({ total: 1, transfers: [transfer] });

      const res = await request(app).get(`/transfers/incoming/${ALICE}`);

      expect(res.status).toBe(200);
      expect(res.body.transfers[0].displayAmount).toBe("1.0000000");
    });

    it("returns empty array for an unknown address", async () => {
      mockQueryTransfers.mockResolvedValue({ total: 0, transfers: [] });

      const res = await request(app).get("/transfers/incoming/GUNKNOWNADDRESS");

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
      expect(res.body.transfers).toHaveLength(0);
    });

    it("forwards contractId filter to queryTransfers", async () => {
      const filtered = SEED_TRANSFERS.filter(
        (t) => t.toAddress === ALICE && t.contractId === CONTRACT_A
      );
      mockQueryTransfers.mockResolvedValue({ total: filtered.length, transfers: filtered });

      const res = await request(app)
        .get(`/transfers/incoming/${ALICE}`)
        .query({ contractId: CONTRACT_A });

      expect(res.status).toBe(200);
      expect(mockQueryTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ contractId: CONTRACT_A, direction: "incoming" })
      );
    });

    it("passes fromDate and toDate to queryTransfers", async () => {
      mockQueryTransfers.mockResolvedValue({ total: 2, transfers: SEED_TRANSFERS.slice(14, 16) });

      const res = await request(app)
        .get(`/transfers/incoming/${ALICE}`)
        .query({ fromDate: "2025-03-01T00:00:00Z", toDate: "2025-03-31T23:59:59Z" });

      expect(res.status).toBe(200);
      const call = mockQueryTransfers.mock.calls[0][0];
      expect(call.fromDate).toBeInstanceOf(Date);
      expect(call.toDate).toBeInstanceOf(Date);
      expect(call.fromDate!.toISOString()).toBe("2025-03-01T00:00:00.000Z");
    });

    it("returns 400 for invalid fromDate", async () => {
      const res = await request(app)
        .get(`/transfers/incoming/${ALICE}`)
        .query({ fromDate: "not-a-date" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid date/i);
    });

    it("returns 400 for invalid toDate", async () => {
      const res = await request(app)
        .get(`/transfers/incoming/${ALICE}`)
        .query({ toDate: "garbage" });

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid eventType", async () => {
      const res = await request(app)
        .get(`/transfers/incoming/${ALICE}`)
        .query({ eventType: "unknown" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid eventType/i);
    });

    it("accepts valid eventType values", async () => {
      mockQueryTransfers.mockResolvedValue({ total: 1, transfers: [makeTransfer({ eventType: "mint" })] });

      const res = await request(app)
        .get(`/transfers/incoming/${ALICE}`)
        .query({ eventType: "mint" });

      expect(res.status).toBe(200);
      expect(mockQueryTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ eventTypes: ["mint"] })
      );
    });

    it("accepts comma-separated eventType values", async () => {
      mockQueryTransfers.mockResolvedValue({ total: 2, transfers: [] });

      const res = await request(app)
        .get(`/transfers/incoming/${ALICE}`)
        .query({ eventType: "transfer,mint" });

      expect(res.status).toBe(200);
      expect(mockQueryTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ eventTypes: ["transfer", "mint"] })
      );
    });

    it("honours limit and offset for pagination", async () => {
      const page = SEED_TRANSFERS.slice(0, 5);
      mockQueryTransfers.mockResolvedValue({ total: 20, transfers: page });

      const res = await request(app)
        .get(`/transfers/incoming/${ALICE}`)
        .query({ limit: "5", offset: "10" });

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(5);
      expect(res.body.offset).toBe(10);
      expect(mockQueryTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5, offset: 10 })
      );
    });

    it("falls back to limit=50, offset=0 when not provided", async () => {
      mockQueryTransfers.mockResolvedValue({ total: 0, transfers: [] });

      await request(app).get(`/transfers/incoming/${ALICE}`);

      expect(mockQueryTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50, offset: 0 })
      );
    });

    it("forwards fromLedger and toLedger filters", async () => {
      mockQueryTransfers.mockResolvedValue({ total: 3, transfers: SEED_TRANSFERS.slice(0, 3) });

      await request(app)
        .get(`/transfers/incoming/${ALICE}`)
        .query({ fromLedger: "1001", toLedger: "1003" });

      expect(mockQueryTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ fromLedger: 1001, toLedger: 1003 })
      );
    });
  });

  // ── /transfers/outgoing/:address ───────────────────────────────────────────
  describe("GET /transfers/outgoing/:address", () => {
    it("returns outgoing transfers with direction=outgoing", async () => {
      const outgoing = SEED_TRANSFERS.filter((t) => t.fromAddress === ALICE);
      mockQueryTransfers.mockResolvedValue({ total: outgoing.length, transfers: outgoing });

      const res = await request(app).get(`/transfers/outgoing/${ALICE}`);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(outgoing.length);
      expect(mockQueryTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ direction: "outgoing", address: ALICE })
      );
    });

    it("returns empty array for address with no outgoing transfers", async () => {
      mockQueryTransfers.mockResolvedValue({ total: 0, transfers: [] });

      const res = await request(app).get(`/transfers/outgoing/GNOBODY`);

      expect(res.status).toBe(200);
      expect(res.body.transfers).toHaveLength(0);
    });

    it("attaches displayAmount for large i128 amounts", async () => {
      const t = makeTransfer({ amount: "1000000000000000" }); // 100000000.0000000
      mockQueryTransfers.mockResolvedValue({ total: 1, transfers: [t] });

      const res = await request(app).get(`/transfers/outgoing/${ALICE}`);

      expect(res.body.transfers[0].displayAmount).toBe("100000000.0000000");
    });

    it("returns 400 for invalid eventType on outgoing route", async () => {
      const res = await request(app)
        .get(`/transfers/outgoing/${ALICE}`)
        .query({ eventType: "bad" });

      expect(res.status).toBe(400);
    });
  });

  // ── /transfers/address/:address ────────────────────────────────────────────
  describe("GET /transfers/address/:address", () => {
    it("returns combined incoming and outgoing transfers", async () => {
      const combined = SEED_TRANSFERS.filter(
        (t) => t.toAddress === ALICE || t.fromAddress === ALICE
      ).map((t) => ({ ...t, direction: t.toAddress === ALICE ? "incoming" : "outgoing" }));

      mockQueryAllTransfers.mockResolvedValue({ total: combined.length, transfers: combined });

      const res = await request(app).get(`/transfers/address/${ALICE}`);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(combined.length);
      expect(res.body.transfers[0]).toHaveProperty("direction");
    });

    it("direction field is present on each record", async () => {
      const t1 = { ...makeTransfer({ id: 1, toAddress: ALICE, fromAddress: BOB }), direction: "incoming" };
      const t2 = { ...makeTransfer({ id: 2, toAddress: BOB, fromAddress: ALICE }), direction: "outgoing" };
      mockQueryAllTransfers.mockResolvedValue({ total: 2, transfers: [t1, t2] });

      const res = await request(app).get(`/transfers/address/${ALICE}`);

      expect(res.body.transfers[0].direction).toBe("incoming");
      expect(res.body.transfers[1].direction).toBe("outgoing");
    });

    it("returns empty array for unknown address", async () => {
      mockQueryAllTransfers.mockResolvedValue({ total: 0, transfers: [] });

      const res = await request(app).get("/transfers/address/GUNKNOWN");

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    });

    it("honours pagination params", async () => {
      mockQueryAllTransfers.mockResolvedValue({ total: 20, transfers: [] });

      await request(app)
        .get(`/transfers/address/${ALICE}`)
        .query({ limit: "10", offset: "5" });

      expect(mockQueryAllTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 5 })
      );
    });

    it("filters by contractId", async () => {
      mockQueryAllTransfers.mockResolvedValue({ total: 3, transfers: [] });

      await request(app)
        .get(`/transfers/address/${ALICE}`)
        .query({ contractId: CONTRACT_B });

      expect(mockQueryAllTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ contractId: CONTRACT_B })
      );
    });

    it("returns 400 for malformed toDate", async () => {
      const res = await request(app)
        .get(`/transfers/address/${ALICE}`)
        .query({ toDate: "2025-bad" });

      expect(res.status).toBe(400);
    });
  });

  // ── /transfers/tx/:txHash ──────────────────────────────────────────────────
  describe("GET /transfers/tx/:txHash", () => {
    it("returns all transfers for a given transaction hash", async () => {
      const txTransfers = SEED_TRANSFERS.filter((t) => t.txHash === "txhash-multi");
      mockQueryByTxHash.mockResolvedValue(txTransfers);

      const res = await request(app).get("/transfers/tx/txhash-multi");

      expect(res.status).toBe(200);
      expect(res.body.transfers).toHaveLength(2);
      expect(res.body.transfers[0]).toHaveProperty("displayAmount");
    });

    it("returns empty array for unknown txHash", async () => {
      mockQueryByTxHash.mockResolvedValue([]);

      const res = await request(app).get("/transfers/tx/nonexistent");

      expect(res.status).toBe(200);
      expect(res.body.transfers).toHaveLength(0);
    });

    it("calls queryByTxHash with the exact txHash from path", async () => {
      mockQueryByTxHash.mockResolvedValue([]);

      await request(app).get("/transfers/tx/abc123def456");

      expect(mockQueryByTxHash).toHaveBeenCalledWith("abc123def456");
    });
  });

  // ── /summary/:address ──────────────────────────────────────────────────────
  describe("GET /summary/:address", () => {
    it("returns token summary with display fields", async () => {
      mockQuerySummary.mockResolvedValue([
        { contractId: CONTRACT_A, totalReceived: "300000000", totalSent: "170000000", txCount: 5n },
      ]);

      const res = await request(app).get(`/summary/${ALICE}`);

      expect(res.status).toBe(200);
      expect(res.body.address).toBe(ALICE);
      expect(res.body.tokens).toHaveLength(1);
      expect(res.body.tokens[0].displayTotalReceived).toBe("30.0000000");
      expect(res.body.tokens[0].displayTotalSent).toBe("17.0000000");
      expect(res.body.tokens[0].txCount).toBe(5);
    });

    it("returns 400 for invalid date range", async () => {
      const res = await request(app)
        .get(`/summary/${ALICE}`)
        .query({ fromDate: "bad" });

      expect(res.status).toBe(400);
    });

    it("returns empty tokens array for unknown address", async () => {
      mockQuerySummary.mockResolvedValue([]);

      const res = await request(app).get("/summary/GNOBODY");

      expect(res.status).toBe(200);
      expect(res.body.tokens).toHaveLength(0);
    });

    it("passes date window to querySummary", async () => {
      mockQuerySummary.mockResolvedValue([]);

      await request(app)
        .get(`/summary/${ALICE}`)
        .query({ fromDate: "2025-01-01T00:00:00Z", toDate: "2025-12-31T23:59:59Z" });

      const call = mockQuerySummary.mock.calls[0][0];
      expect(call.fromDate).toBeInstanceOf(Date);
      expect(call.toDate).toBeInstanceOf(Date);
    });
  });

  // ── toDisplayAmount edge cases ─────────────────────────────────────────────
  describe("toDisplayAmount formatting", () => {
    it("formats 0 correctly", async () => {
      mockQueryTransfers.mockResolvedValue({ total: 1, transfers: [makeTransfer({ amount: "0" })] });
      const res = await request(app).get(`/transfers/incoming/${ALICE}`);
      expect(res.body.transfers[0].displayAmount).toBe("0.0000000");
    });

    it("formats small amounts with leading zeros in fractional part", async () => {
      mockQueryTransfers.mockResolvedValue({ total: 1, transfers: [makeTransfer({ amount: "1" })] });
      const res = await request(app).get(`/transfers/incoming/${ALICE}`);
      expect(res.body.transfers[0].displayAmount).toBe("0.0000001");
    });

    it("formats exactly 1 token (10000000 stroops)", async () => {
      mockQueryTransfers.mockResolvedValue({ total: 1, transfers: [makeTransfer({ amount: "10000000" })] });
      const res = await request(app).get(`/transfers/incoming/${ALICE}`);
      expect(res.body.transfers[0].displayAmount).toBe("1.0000000");
    });
  });

  // ── Utility routes ─────────────────────────────────────────────────────────
  describe("GET /healthz", () => {
    it("returns 200 and ok:true", async () => {
      const res = await request(app).get("/healthz");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("GET /status", () => {
    it("returns indexer status fields", async () => {
      const res = await request(app).get("/status");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body).toHaveProperty("lastIndexedLedger");
      expect(res.body).toHaveProperty("latestLedger");
    });
  });

  describe("404 handler", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await request(app).get("/nonexistent/route");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Not found");
    });
  });

  // ── /transfers/address/:address/export.csv ─────────────────────────────────
  describe("GET /transfers/address/:address/export.csv", () => {
    it("returns valid CSV with correct headers", async () => {
      const transfers = [
        { ...makeTransfer({
          id: 1,
          fromAddress: BOB,
          toAddress: ALICE,
          contractId: CONTRACT_A,
          amount: "10000000",
          ledgerClosedAt: new Date("2025-01-15T10:30:45Z"),
          ledger: 1001,
          eventType: "transfer",
        }), direction: "incoming" as const },
      ];
      mockQueryAllTransfers.mockResolvedValue({ total: 1, transfers });

      const res = await request(app).get(`/transfers/address/${ALICE}/export.csv`);

      expect(res.status).toBe(200);
      expect(res.get("Content-Type")).toMatch(/text\/csv/);
      expect(res.text).toContain("date,type,from,to,amount,token,ledger");
    });

    it("includes all transfers as CSV rows", async () => {
      const transfers = [
        { ...makeTransfer({
          id: 1,
          fromAddress: BOB,
          toAddress: ALICE,
          contractId: CONTRACT_A,
          amount: "10000000",
          ledgerClosedAt: new Date("2025-01-15T10:30:45Z"),
          ledger: 1001,
          eventType: "transfer",
        }), direction: "incoming" as const },
        { ...makeTransfer({
          id: 2,
          fromAddress: null,
          toAddress: ALICE,
          contractId: CONTRACT_B,
          amount: "20000000",
          ledgerClosedAt: new Date("2025-01-16T11:30:45Z"),
          ledger: 1002,
          eventType: "mint",
        }), direction: "incoming" as const },
      ];
      mockQueryAllTransfers.mockResolvedValue({ total: 2, transfers });

      const res = await request(app).get(`/transfers/address/${ALICE}/export.csv`);

      expect(res.status).toBe(200);
      const lines = res.text.split("\n");
      expect(lines).toHaveLength(3); // header + 2 rows
      expect(lines[1]).toContain("1.0000000"); // displayAmount for 10000000 stroops
      expect(lines[1]).toContain(BOB);
      expect(lines[1]).toContain(CONTRACT_A);
      expect(lines[1]).toContain("1001");
    });

    it("converts amount to displayAmount in CSV output", async () => {
      const transfers = [
        { ...makeTransfer({
          id: 1,
          fromAddress: ALICE,
          toAddress: BOB,
          contractId: CONTRACT_A,
          amount: "100000000", // 10.0000000
          ledgerClosedAt: new Date("2025-01-15T10:30:45Z"),
          ledger: 1001,
          eventType: "transfer",
        }), direction: "outgoing" as const },
      ];
      mockQueryAllTransfers.mockResolvedValue({ total: 1, transfers });

      const res = await request(app).get(`/transfers/address/${ALICE}/export.csv`);

      expect(res.status).toBe(200);
      expect(res.text).toContain("10.0000000");
    });

    it("handles null fromAddress by using empty string in CSV", async () => {
      const transfers = [
        { ...makeTransfer({
          id: 1,
          fromAddress: null,
          toAddress: ALICE,
          contractId: CONTRACT_A,
          amount: "10000000",
          ledgerClosedAt: new Date("2025-01-15T10:30:45Z"),
          ledger: 1001,
          eventType: "mint",
        }), direction: "incoming" as const },
      ];
      mockQueryAllTransfers.mockResolvedValue({ total: 1, transfers });

      const res = await request(app).get(`/transfers/address/${ALICE}/export.csv`);

      expect(res.status).toBe(200);
      // After "mint" there should be an empty field (,,) for the empty fromAddress
      expect(res.text).toContain("mint,,"); // type,empty-from,to
    });

    it("handles null toAddress by using empty string in CSV", async () => {
      const transfers = [
        { ...makeTransfer({
          id: 1,
          fromAddress: ALICE,
          toAddress: null,
          contractId: CONTRACT_A,
          amount: "10000000",
          ledgerClosedAt: new Date("2025-01-15T10:30:45Z"),
          ledger: 1001,
          eventType: "burn",
        }), direction: "outgoing" as const },
      ];
      mockQueryAllTransfers.mockResolvedValue({ total: 1, transfers });

      const res = await request(app).get(`/transfers/address/${ALICE}/export.csv`);

      expect(res.status).toBe(200);
      expect(res.text).toContain(ALICE); // fromAddress
      expect(res.text).toContain(",burn,"); // contains burn event
    });

    it("sets Content-Disposition header with filename", async () => {
      mockQueryAllTransfers.mockResolvedValue({ total: 0, transfers: [] });

      const res = await request(app).get(`/transfers/address/${ALICE}/export.csv`);

      expect(res.status).toBe(200);
      const disposition = res.get("Content-Disposition");
      expect(disposition).toContain("attachment");
      expect(disposition).toContain(`filename="transfers-${ALICE}.csv"`);
    });

    it("respects contractId filter", async () => {
      mockQueryAllTransfers.mockResolvedValue({ total: 0, transfers: [] });

      await request(app)
        .get(`/transfers/address/${ALICE}/export.csv`)
        .query({ contractId: CONTRACT_A });

      expect(mockQueryAllTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ contractId: CONTRACT_A })
      );
    });

    it("respects fromDate and toDate filters", async () => {
      mockQueryAllTransfers.mockResolvedValue({ total: 0, transfers: [] });

      await request(app)
        .get(`/transfers/address/${ALICE}/export.csv`)
        .query({
          fromDate: "2025-01-01T00:00:00Z",
          toDate: "2025-01-31T23:59:59Z",
        });

      expect(mockQueryAllTransfers).toHaveBeenCalledWith(
        expect.objectContaining({
          fromDate: expect.any(Date),
          toDate: expect.any(Date),
        })
      );
    });

    it("respects eventType filter", async () => {
      mockQueryAllTransfers.mockResolvedValue({ total: 0, transfers: [] });

      await request(app)
        .get(`/transfers/address/${ALICE}/export.csv`)
        .query({ eventType: "transfer,mint" });

      expect(mockQueryAllTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ eventTypes: ["transfer", "mint"] })
      );
    });

    it("enforces a 10,000 row cap for export", async () => {
      mockQueryAllTransfers.mockResolvedValue({ total: 50000, transfers: [] });

      await request(app).get(`/transfers/address/${ALICE}/export.csv`);

      expect(mockQueryAllTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10000, offset: 0 })
      );
    });

    it("always uses offset=0 for CSV export", async () => {
      mockQueryAllTransfers.mockResolvedValue({ total: 100, transfers: [] });

      await request(app).get(`/transfers/address/${ALICE}/export.csv`);

      expect(mockQueryAllTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 0 })
      );
    });

    it("returns 400 for invalid fromDate", async () => {
      const res = await request(app)
        .get(`/transfers/address/${ALICE}/export.csv`)
        .query({ fromDate: "invalid-date" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid date/i);
    });

    it("returns 400 for invalid eventType", async () => {
      const res = await request(app)
        .get(`/transfers/address/${ALICE}/export.csv`)
        .query({ eventType: "badtype" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid eventType/i);
    });

    it("returns empty CSV (header only) for address with no transfers", async () => {
      mockQueryAllTransfers.mockResolvedValue({ total: 0, transfers: [] });

      const res = await request(app).get(`/transfers/address/${ALICE}/export.csv`);

      expect(res.status).toBe(200);
      expect(res.text).toBe("date,type,from,to,amount,token,ledger");
    });

    it("properly escapes CSV values with commas", async () => {
      const transfers = [
        { ...makeTransfer({
          id: 1,
          fromAddress: BOB,
          toAddress: ALICE,
          contractId: "CONTRACT,WITH,COMMAS",
          amount: "10000000",
          ledgerClosedAt: new Date("2025-01-15T10:30:45Z"),
          ledger: 1001,
          eventType: "transfer",
        }), direction: "incoming" as const },
      ];
      mockQueryAllTransfers.mockResolvedValue({ total: 1, transfers });

      const res = await request(app).get(`/transfers/address/${ALICE}/export.csv`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('"CONTRACT,WITH,COMMAS"');
    });
  });
});

