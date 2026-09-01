import request from "supertest";
import { createApp } from "../api";
import {
  ledgersIndexedTotal,
  transfersStoredTotal,
  lastIndexedLedger,
  observeDbQuery,
  recordRpcError,
  registry,
  _resetMetrics,
} from "../metrics";

jest.mock("../db", () => ({
  getLastIndexedLedger: jest.fn().mockResolvedValue(1000),
  getLastIndexedState: jest.fn(),
  queryTransfers: jest.fn(),
  queryAllTransfers: jest.fn(),
  queryByTxHash: jest.fn(),
  querySummary: jest.fn(),
  queryNftTransfers: jest.fn(),
  getNftOwner: jest.fn(),
  getNftMetadata: jest.fn(),
  prisma: { $queryRaw: jest.fn().mockResolvedValue([{ 1: 1 }]) },
}));

jest.mock("../rpc", () => ({
  getLatestLedger: jest.fn().mockResolvedValue(1050),
}));

jest.mock("../indexer", () => ({
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest
    .fn()
    .mockReturnValue({ startedAt: "2024-01-01T00:00:00.000Z", uptimeSeconds: 100, totalIndexed: 50 }),
}));

describe("Prometheus metrics (#39)", () => {
  const app = createApp();

  beforeEach(() => {
    _resetMetrics();
  });

  describe("GET /metrics", () => {
    it("serves Prometheus text exposition format", async () => {
      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      // Every series in the exposition format is preceded by its HELP and TYPE
      // lines; a body without them is not something Prometheus will scrape.
      expect(res.text).toMatch(/^# HELP /m);
      expect(res.text).toMatch(/^# TYPE /m);
    });

    it("exports every custom metric, declared with the right type", async () => {
      const res = await request(app).get("/metrics");

      expect(res.text).toContain("# TYPE ledgers_indexed_total counter");
      expect(res.text).toContain("# TYPE transfers_stored_total counter");
      expect(res.text).toContain("# TYPE rpc_errors_total counter");
      expect(res.text).toContain("# TYPE last_indexed_ledger gauge");
      expect(res.text).toContain("# TYPE db_query_duration_seconds histogram");
    });

    it("reports recorded samples with their labels", async () => {
      ledgersIndexedTotal.inc({ network: "testnet" }, 12);
      transfersStoredTotal.inc({ network: "testnet", type: "fungible" }, 5);
      transfersStoredTotal.inc({ network: "testnet", type: "nft" }, 2);
      lastIndexedLedger.set({ network: "testnet" }, 987_654);
      recordRpcError("retry");

      const res = await request(app).get("/metrics");

      expect(res.text).toContain('ledgers_indexed_total{network="testnet"} 12');
      expect(res.text).toContain('transfers_stored_total{network="testnet",type="fungible"} 5');
      expect(res.text).toContain('transfers_stored_total{network="testnet",type="nft"} 2');
      expect(res.text).toContain('last_indexed_ledger{network="testnet"} 987654');
      expect(res.text).toContain('rpc_errors_total{outcome="retry"} 1');
    });

    it("does not depend on the database or RPC being up", async () => {
      // The scrape must still answer when the things it reports on are broken —
      // otherwise monitoring goes dark exactly when it is needed.
      const { prisma } = jest.requireMock("../db");
      const { getLatestLedger } = jest.requireMock("../rpc");
      prisma.$queryRaw.mockRejectedValueOnce(new Error("db down"));
      getLatestLedger.mockRejectedValueOnce(new Error("rpc down"));

      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.text).toContain("# TYPE ledgers_indexed_total counter");
    });
  });

  describe("observeDbQuery", () => {
    it("times a successful query under its operation label", async () => {
      const value = await observeDbQuery("someQuery", async () => "result");

      expect(value).toBe("result");
      const text = await registry.metrics();
      expect(text).toContain('db_query_duration_seconds_count{operation="someQuery"} 1');
    });

    it("still times a query that throws, and rethrows it", async () => {
      // A query that takes eight seconds and then fails is the one worth
      // seeing; dropping it would make the histogram describe only good runs.
      await expect(
        observeDbQuery("failingQuery", async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");

      const text = await registry.metrics();
      expect(text).toContain('db_query_duration_seconds_count{operation="failingQuery"} 1');
    });
  });

  describe("recordRpcError", () => {
    it("separates a retried attempt from an exhausted one", async () => {
      recordRpcError("retry");
      recordRpcError("retry");
      recordRpcError("exhausted");

      const res = await request(app).get("/metrics");
      expect(res.text).toContain('rpc_errors_total{outcome="retry"} 2');
      expect(res.text).toContain('rpc_errors_total{outcome="exhausted"} 1');
    });
  });

  describe("GET /status", () => {
    it("reports last_indexed_ledger alongside the camelCase field", async () => {
      const res = await request(app).get("/status");

      expect(res.status).toBe(200);
      expect(res.body.last_indexed_ledger).toBe(1000);
      expect(res.body.lastIndexedLedger).toBe(1000);
    });
  });
});
