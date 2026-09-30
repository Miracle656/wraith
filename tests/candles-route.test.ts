import { inspect } from "node:util";
import { Prisma } from "@prisma/client";
import request from "supertest";

jest.mock("../src/db", () => ({
  getLastIndexedLedger: jest.fn().mockResolvedValue(1000),
  queryTransfers: jest.fn(),
  queryAllTransfers: jest.fn(),
  queryByTxHash: jest.fn(),
  querySummary: jest.fn(),
  queryNftTransfers: jest.fn(),
  getNftOwner: jest.fn(),
  getNftMetadata: jest.fn(),
  prisma: {
    $queryRawUnsafe: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

jest.mock("../src/rpc", () => ({
  getLatestLedger: jest.fn().mockResolvedValue(1050),
}));

jest.mock("../src/indexer", () => ({
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest.fn().mockReturnValue({ uptimeSeconds: 0, totalIndexed: 0 }),
}));

// The real application still mounts its routers and middleware. Only the
// unrelated GraphQL server is replaced to avoid starting its background work.
jest.mock("../src/graphql/server", () => ({
  createGraphQLMiddleware: () => require("express").Router(),
}));

import { createApp, clearRpcHealthCache } from "../src/api";
import { prisma } from "../src/db";

const queryCandles = prisma.$queryRawUnsafe as jest.Mock;
const refreshCandles = prisma.$queryRaw as jest.Mock;
const CONTRACT = `C${"A".repeat(55)}`;
const SECRET = "private-database-connection-secret";

describe("candles routes through createApp", () => {
  const originalEnv = { ...process.env };
  let app: ReturnType<typeof createApp>;
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    process.env.NETWORKS = "testnet";
    process.env.STELLAR_NETWORK = "testnet";
    process.env.CACHE_ENABLED = "false";
    clearRpcHealthCache();
    queryCandles.mockReset().mockResolvedValue([]);
    refreshCandles.mockReset().mockResolvedValue([]);
    errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    app = createApp();
  });

  afterEach(() => {
    errorLog.mockRestore();
    process.env = { ...originalEnv };
  });

  it.each(["1m", "1h", "1d"])(
    "serves the %s aggregate with the default pagination",
    async (bucket) => {
      queryCandles.mockResolvedValue([
        {
          time_bucket: new Date("2026-09-28T12:00:00.000Z"),
          contract_id: CONTRACT,
          // PostgreSQL NUMERIC values arrive as Prisma.Decimal, so exercise
          // real Express JSON serialization without losing decimal precision.
          open_price: new Prisma.Decimal("1.100000000000000001"),
          high_price: new Prisma.Decimal("1.500000000000000001"),
          low_price: new Prisma.Decimal("1.000000000000000001"),
          close_price: new Prisma.Decimal("1.300000000000000001"),
          volume: new Prisma.Decimal("9007199254740993.0000001"),
          tx_count: 7,
        },
      ]);

      const res = await request(app).get(`/candles/${bucket}/${CONTRACT}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        bucket,
        contractId: CONTRACT,
        candles: [
          {
            timeBucket: "2026-09-28T12:00:00.000Z",
            contractId: CONTRACT,
            open: "1.100000000000000001",
            high: "1.500000000000000001",
            low: "1.000000000000000001",
            close: "1.300000000000000001",
            volume: "9007199254740993.0000001",
            txCount: 7,
          },
        ],
      });
      expect(queryCandles).toHaveBeenCalledTimes(1);
      // Prisma accepts each placeholder value as a separate argument, not an
      // array containing all three values as the single value for $1.
      expect(queryCandles).toHaveBeenCalledWith(
        expect.stringContaining(`FROM ohlc.candles_${bucket}`),
        CONTRACT,
        100,
        0,
      );
      const sql = queryCandles.mock.calls[0][0] as string;
      expect(sql).toMatch(/WHERE contract_id = \$1/);
      expect(sql).toMatch(/ORDER BY time_bucket DESC/);
      expect(sql).toMatch(/LIMIT \$2 OFFSET \$3/);
      expect(sql).not.toContain(CONTRACT);
    },
  );

  it("passes explicit limit and offset as separate SQL parameters", async () => {
    const res = await request(app)
      .get(`/candles/1h/${CONTRACT}`)
      .query({ limit: 25, offset: 50 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bucket: "1h", contractId: CONTRACT, candles: [] });
    expect(queryCandles).toHaveBeenCalledWith(expect.any(String), CONTRACT, 25, 50);
  });

  it("accepts the documented upper page-size boundary", async () => {
    const res = await request(app)
      .get(`/candles/1d/${CONTRACT}`)
      .query({ limit: 1000, offset: 0 });

    expect(res.status).toBe(200);
    expect(queryCandles).toHaveBeenCalledWith(expect.any(String), CONTRACT, 1000, 0);
  });

  it.each([
    ["unsupported bucket", `/candles/5m/${CONTRACT}`],
    ["invalid contract ID", "/candles/1m/not-a-contract"],
    ["zero limit", `/candles/1m/${CONTRACT}?limit=0`],
    ["oversized limit", `/candles/1m/${CONTRACT}?limit=1001`],
    ["fractional limit", `/candles/1m/${CONTRACT}?limit=1.5`],
    ["non-numeric limit", `/candles/1m/${CONTRACT}?limit=abc`],
    ["negative offset", `/candles/1m/${CONTRACT}?offset=-1`],
    ["fractional offset", `/candles/1m/${CONTRACT}?offset=1.5`],
    ["non-numeric offset", `/candles/1m/${CONTRACT}?offset=abc`],
  ])("rejects %s before querying the database", async (_description, url) => {
    const res = await request(app).get(url);

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(queryCandles).not.toHaveBeenCalled();
  });

  it("returns a sanitized 500 when reading candles fails", async () => {
    const databaseError = new Error(`Connection failed: ${SECRET}`);
    queryCandles.mockRejectedValue(databaseError);

    const res = await request(app).get(`/candles/1m/${CONTRACT}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to query candles" });
    expect(res.text).not.toContain(SECRET);
    expect(errorLog.mock.calls.flat()).not.toContain(databaseError);
    expect(inspect(errorLog.mock.calls, { depth: null })).not.toContain(SECRET);
  });

  it("refreshes all three aggregate buckets through the mounted POST route", async () => {
    refreshCandles
      .mockResolvedValueOnce([{ rows_inserted: 3, rows_updated: 2 }])
      .mockResolvedValueOnce([{ rows_inserted: 4, rows_updated: 1 }])
      .mockResolvedValueOnce([{ rows_inserted: 5, rows_updated: 0 }]);

    const res = await request(app).post("/candles/refresh").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      oneMinute: { inserted: 3, updated: 2 },
      oneHour: { inserted: 4, updated: 1 },
      oneDay: { inserted: 5, updated: 0 },
    });
    expect(refreshCandles).toHaveBeenCalledTimes(3);
    for (const [index, bucket] of ["1m", "1h", "1d"].entries()) {
      expect(String(refreshCandles.mock.calls[index][0])).toContain(
        `ohlc.refresh_candles_${bucket}()`,
      );
    }
    expect(queryCandles).not.toHaveBeenCalled();
  });

  it("returns zero counts when refresh functions return no rows", async () => {
    const res = await request(app).post("/candles/refresh").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      oneMinute: { inserted: 0, updated: 0 },
      oneHour: { inserted: 0, updated: 0 },
      oneDay: { inserted: 0, updated: 0 },
    });
  });

  it("returns a sanitized 500 when an aggregate refresh fails", async () => {
    const databaseError = new Error(`Refresh failed: ${SECRET}`);
    refreshCandles.mockRejectedValueOnce(databaseError);

    const res = await request(app).post("/candles/refresh").send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to refresh candles" });
    expect(res.text).not.toContain(SECRET);
    expect(errorLog.mock.calls.flat()).not.toContain(databaseError);
    expect(inspect(errorLog.mock.calls, { depth: null })).not.toContain(SECRET);
  });
});
