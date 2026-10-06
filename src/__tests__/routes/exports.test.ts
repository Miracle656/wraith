import request from "supertest";

// ── Module mocks must be declared before any imports that use them ──────────
jest.mock("../../db", () => ({
  queryTransfers: jest.fn(),
  queryAllTransfers: jest.fn(),
  queryByTxHash: jest.fn(),
  querySummary: jest.fn(),
  getLastIndexedLedger: jest.fn(),
  toDisplayAmount: jest.fn((amount: string) => amount),
  prisma: {
    $queryRaw: jest.fn(),
    tokenMetadata: { findMany: jest.fn() },
    tokenTransfer: { findMany: jest.fn() },
  },
}));

jest.mock("../../rpc", () => ({ getLatestLedger: jest.fn() }));

jest.mock("../../indexer", () => ({
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest
    .fn()
    .mockReturnValue({ startedAt: "2024-01-01T00:00:00.000Z", uptimeSeconds: 0, totalIndexed: 0 }),
}));

import { createApp } from "../../api";
import { prisma } from "../../db";

const mockFindMany = prisma.tokenTransfer.findMany as jest.MockedFunction<
  typeof prisma.tokenTransfer.findMany
>;

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function row(id: number) {
  return {
    id,
    contractId: CONTRACT,
    eventType: "transfer",
    fromAddress: ALICE,
    toAddress: ALICE,
    amount: "100",
    ledger: 1000 + id,
    ledgerClosedAt: new Date("2026-01-01T00:00:00Z"),
    txHash: `hash${id}`,
    eventId: `event${id}`,
    isSac: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

/**
 * Serve `total` rows, honouring `skip`/`take` the way Prisma does.
 *
 * The cap probe is a `skip: max, take: 1` query against the same filter, so a
 * mock that ignores `skip` would answer "truncated" for every request and the
 * tests would pass for the wrong reason.
 */
function seed(total: number) {
  mockFindMany.mockImplementation((async (args: {
    skip?: number;
    take?: number;
    cursor?: { id: number };
  }) => {
    const all = Array.from({ length: total }, (_, i) => row(i + 1));
    const after = args.cursor ? all.findIndex((r) => r.id === args.cursor!.id) + 1 : 0;
    const from = after + (args.skip ?? 0);
    return all.slice(from, from + (args.take ?? all.length));
  }) as never);
}

beforeEach(() => {
  jest.clearAllMocks();
});

/**
 * Bounding and validating the exports (#185).
 *
 * The cap is the point of the feature, but the header that announces it is
 * where the danger was: setting a response header after the CSV body has begun
 * throws ERR_HTTP_HEADERS_SENT, which skips `csvStream.end()` and leaves the
 * client holding a response that never terminates — and it only happens on the
 * truncation path, the one case the signalling exists for.
 */
describe("GET /transfers.csv", () => {
  it("rejects a non-numeric fromLedger with 400, not 500", async () => {
    const res = await request(createApp()).get("/transfers.csv?fromLedger=abc");

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    // Nothing was queried: validation happens before the database is touched.
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("rejects an unparseable date with 400", async () => {
    const res = await request(createApp()).get("/transfers.csv?fromDate=not-a-date");
    expect(res.status).toBe(400);
  });

  it("rejects maxRows above the absolute ceiling", async () => {
    const res = await request(createApp()).get("/transfers.csv?maxRows=999999999");
    expect(res.status).toBe(400);
  });

  it("stops at the cap and says so, in headers that arrive before the body", async () => {
    seed(10);

    const res = await request(createApp()).get("/transfers.csv?maxRows=4");

    expect(res.status).toBe(200);
    expect(res.headers["x-truncated"]).toBe("true");
    expect(res.headers["x-row-limit"]).toBe("4");

    // The response terminated — the failure mode here was a body that never ends.
    const dataLines = res.text.trim().split("\n").slice(1);
    expect(dataLines).toHaveLength(4);
  });

  it("does not claim truncation when the rows end exactly at the cap", async () => {
    seed(4);

    const res = await request(createApp()).get("/transfers.csv?maxRows=4");

    expect(res.status).toBe(200);
    expect(res.headers["x-truncated"]).toBeUndefined();
    expect(res.text.trim().split("\n").slice(1)).toHaveLength(4);
  });

  it("returns everything, unflagged, when the result is under the cap", async () => {
    seed(3);

    const res = await request(createApp()).get("/transfers.csv?maxRows=10");

    expect(res.headers["x-truncated"]).toBeUndefined();
    expect(res.text.trim().split("\n").slice(1)).toHaveLength(3);
  });

  it("returns an empty export rather than failing when nothing matches", async () => {
    seed(0);

    const res = await request(createApp()).get("/transfers.csv");

    expect(res.status).toBe(200);
    expect(res.headers["x-truncated"]).toBeUndefined();
  });
});
