import request from "supertest";
import { createApp, clearRpcHealthCache } from "../api";

jest.mock("../db", () => ({
  getLastIndexedLedger: jest.fn(),
  getLastIndexedState: jest.fn(),
  queryTransfers: jest.fn(),
  queryAllTransfers: jest.fn(),
  queryByTxHash: jest.fn(),
  querySummary: jest.fn(),
  prisma: { $queryRaw: jest.fn() },
}));

jest.mock("../rpc", () => ({
  getLatestLedger: jest.fn(),
}));

jest.mock("../indexer", () => ({
  // #161: /status also reads per-network loop state. Listed explicitly
  // because a partial mock silently 500s the route rather than failing loudly.
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest
    .fn()
    .mockReturnValue({ startedAt: "2024-01-01T00:00:00.000Z", uptimeSeconds: 100, totalIndexed: 50 }),
}));

import { queryTransfers, getLastIndexedLedger, prisma } from "../db";
import { getLatestLedger } from "../rpc";

const mockQueryTransfers = queryTransfers as jest.MockedFunction<typeof queryTransfers>;
const mockGetLastIndexedLedger = getLastIndexedLedger as jest.MockedFunction<typeof getLastIndexedLedger>;
const mockGetLatestLedger = getLatestLedger as jest.MockedFunction<typeof getLatestLedger>;
const mockQueryRaw = prisma.$queryRaw as jest.MockedFunction<typeof prisma.$queryRaw>;

const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

describe("Graceful stale reads during RPC outage (#164)", () => {
  const app = createApp();

  beforeEach(() => {
    jest.clearAllMocks();
    clearRpcHealthCache();
    mockGetLastIndexedLedger.mockResolvedValue(1000);
    mockGetLatestLedger.mockResolvedValue(1050);
    mockQueryRaw.mockResolvedValue([{ 1: 1 }]);
  });

  describe("Read routes during RPC outage", () => {
    it("returns DB data with staleness markers when RPC is down", async () => {
      mockGetLatestLedger.mockRejectedValue(new Error("Soroban RPC connection refused"));
      mockQueryTransfers.mockResolvedValue({
        total: 1,
        transfers: [
          {
            id: 1,
            contractId: "C123",
            eventType: "transfer",
            fromAddress: "GBOB",
            toAddress: ALICE,
            amount: "10000000",
            ledger: 999,
            ledgerClosedAt: new Date("2025-01-01T00:00:00Z"),
            txHash: "tx123",
            eventId: "evt123",
          },
        ],
        nextCursor: null,
      });

      const res = await request(app).get(`/transfers/incoming/${ALICE}`);

      expect(res.status).toBe(200);
      expect(res.headers["x-data-stale"]).toBe("true");
      expect(res.headers["x-as-of-ledger"]).toBe("1000");
      expect(res.body.stale).toBe(true);
      expect(res.body.as_of_ledger).toBe(1000);
      expect(res.body.transfers).toHaveLength(1);
    });

    it("resumes normal non-stale headers after RPC recovers", async () => {
      mockGetLatestLedger.mockRejectedValueOnce(new Error("RPC outage"));
      mockQueryTransfers.mockResolvedValue({ total: 0, transfers: [], nextCursor: null });

      const res1 = await request(app).get(`/transfers/incoming/${ALICE}`);
      expect(res1.status).toBe(200);
      expect(res1.headers["x-data-stale"]).toBe("true");

      clearRpcHealthCache();
      mockGetLatestLedger.mockResolvedValue(1050);

      const res2 = await request(app).get(`/transfers/incoming/${ALICE}`);
      expect(res2.status).toBe(200);
      expect(res2.headers["x-data-stale"]).toBeUndefined();
      expect(res2.body.stale).toBeUndefined();
    });
  });

  describe("GET /status during outages", () => {
    it("returns status 'healthy' when both DB and RPC are up", async () => {
      const res = await request(app).get("/status");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe("healthy");
      expect(res.body.lastIndexedLedger).toBe(1000);
      expect(res.body.latestLedger).toBe(1050);
      expect(res.body.lagLedgers).toBe(50);
    });

    it("returns status 'degraded' when RPC is down but DB is healthy", async () => {
      mockGetLatestLedger.mockRejectedValue(new Error("RPC down"));

      const res = await request(app).get("/status");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe("degraded");
      expect(res.body.stale).toBe(true);
      expect(res.body.as_of_ledger).toBe(1000);
      expect(res.body.latestLedger).toBeNull();
      expect(res.body.lagLedgers).toBeNull();
      expect(res.headers["x-data-stale"]).toBe("true");
    });

    it("returns status 'down' (HTTP 503) when DB is down", async () => {
      mockGetLastIndexedLedger.mockRejectedValue(new Error("DB connection lost"));

      const res = await request(app).get("/status");

      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.status).toBe("down");
      expect(res.body.error).toBe("Database unavailable");
    });
  });

  describe("GET /readyz during outages", () => {
    it("returns status 'healthy' when DB, RPC and indexer lag are ok", async () => {
      const res = await request(app).get("/readyz");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe("healthy");
      expect(res.body.checks).toEqual({ db: true, rpc: true, indexerCaughtUp: true });
    });

    it("degrades to 200 with status 'degraded' when RPC is down but DB is healthy", async () => {
      mockGetLatestLedger.mockRejectedValue(new Error("RPC down"));

      const res = await request(app).get("/readyz");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe("degraded");
      expect(res.body.stale).toBe(true);
      expect(res.body.as_of_ledger).toBe(1000);
      expect(res.body.checks.db).toBe(true);
      expect(res.body.checks.rpc).toBe(false);
      expect(res.headers["x-data-stale"]).toBe("true");
    });

    it("returns HTTP 503 with status 'down' when DB is down", async () => {
      mockQueryRaw.mockRejectedValue(new Error("DB error"));

      const res = await request(app).get("/readyz");

      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.status).toBe("down");
      expect(res.body.checks.db).toBe(false);
    });
  });
});
