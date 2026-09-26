import request from "supertest";
import { createApp, clearRpcHealthCache } from "../api";

jest.mock("../db", () => ({
  queryTransfers: jest.fn(),
  queryAllTransfers: jest.fn(),
  queryByTxHash: jest.fn(),
  querySummary: jest.fn(),
  queryNftTransfers: jest.fn(),
  getNftOwner: jest.fn(),
  getNftMetadata: jest.fn(),
  getLastIndexedLedger: jest.fn(),
  getAccountSummary: jest.fn(),
  queryPopularAssets: jest.fn(),
  toDisplayAmount: jest.requireActual("../db").toDisplayAmount,
  prisma: { $queryRaw: jest.fn() },
}));

jest.mock("../rpc", () => ({
  getLatestLedger: jest.fn(),
}));

jest.mock("../indexer", () => ({
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest
    .fn()
    .mockReturnValue({ startedAt: "2024-01-01T00:00:00.000Z", uptimeSeconds: 0, totalIndexed: 0 }),
}));

import {
  queryTransfers,
  queryAllTransfers,
  queryByTxHash,
  querySummary,
  getLastIndexedLedger,
  prisma,
} from "../db";
import { getLatestLedger } from "../rpc";

const mockQueryTransfers = queryTransfers as jest.MockedFunction<typeof queryTransfers>;
const mockQueryAllTransfers = queryAllTransfers as jest.MockedFunction<typeof queryAllTransfers>;
const mockQueryByTxHash = queryByTxHash as jest.MockedFunction<typeof queryByTxHash>;
const mockQuerySummary = querySummary as jest.MockedFunction<typeof querySummary>;
const mockGetLastIndexedLedger = getLastIndexedLedger as jest.MockedFunction<typeof getLastIndexedLedger>;
const mockGetLatestLedger = getLatestLedger as jest.MockedFunction<typeof getLatestLedger>;
const mockQueryRaw = prisma.$queryRaw as jest.MockedFunction<typeof prisma.$queryRaw>;

const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const emptyPage = { total: 0, transfers: [], nextCursor: null };

describe("API network selector (#163)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    clearRpcHealthCache();
    // Both chains indexed, so a selector has something to choose between.
    process.env.NETWORKS = "testnet,mainnet";
    process.env.STELLAR_NETWORK = "testnet";
    mockQueryTransfers.mockResolvedValue(emptyPage as never);
    mockQueryAllTransfers.mockResolvedValue(emptyPage as never);
    mockQueryByTxHash.mockResolvedValue([] as never);
    mockQuerySummary.mockResolvedValue([] as never);
    mockGetLastIndexedLedger.mockResolvedValue(1000);
    mockGetLatestLedger.mockResolvedValue(1050);
    mockQueryRaw.mockResolvedValue([{ 1: 1 }] as never);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("selection", () => {
    it("defaults to the configured network when no selector is given", async () => {
      await request(createApp()).get(`/transfers/incoming/${ALICE}`).expect(200);

      expect(mockQueryTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ network: "testnet" }),
      );
    });

    it("reads mainnet when ?network=mainnet is given", async () => {
      await request(createApp()).get(`/transfers/incoming/${ALICE}?network=mainnet`).expect(200);

      expect(mockQueryTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ network: "mainnet" }),
      );
    });

    it("accepts the X-Network header as an alternative to the query param", async () => {
      await request(createApp())
        .get(`/transfers/incoming/${ALICE}`)
        .set("X-Network", "mainnet")
        .expect(200);

      expect(mockQueryTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ network: "mainnet" }),
      );
    });

    it("lets the query param win over the header", async () => {
      // A pasted link should beat whatever default an HTTP client sets.
      await request(createApp())
        .get(`/transfers/incoming/${ALICE}?network=mainnet`)
        .set("X-Network", "testnet")
        .expect(200);

      expect(mockQueryTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ network: "mainnet" }),
      );
    });

    it("is case- and whitespace-insensitive", async () => {
      await request(createApp()).get(`/transfers/incoming/${ALICE}?network=%20MAINNET%20`).expect(200);

      expect(mockQueryTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ network: "mainnet" }),
      );
    });

    it("threads the selection through every read route", async () => {
      const app = createApp();

      await request(app).get(`/transfers/outgoing/${ALICE}?network=mainnet`).expect(200);
      await request(app).get(`/transfers/address/${ALICE}?network=mainnet`).expect(200);
      await request(app).get("/transfers/tx/deadbeef?network=mainnet").expect(200);
      await request(app).get(`/summary/${ALICE}?network=mainnet`).expect(200);

      expect(mockQueryTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ network: "mainnet", direction: "outgoing" }),
      );
      expect(mockQueryAllTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ network: "mainnet" }),
      );
      expect(mockQueryByTxHash).toHaveBeenCalledWith("deadbeef", "mainnet");
      expect(mockQuerySummary).toHaveBeenCalledWith(
        expect.objectContaining({ network: "mainnet" }),
      );
    });
  });

  describe("validation", () => {
    it("400s on a value that is not a network at all", async () => {
      const res = await request(createApp())
        .get(`/transfers/incoming/${ALICE}?network=mainet`)
        .expect(400);

      expect(res.body.error).toContain('Invalid network: "mainet"');
      expect(res.body.error).toContain("testnet, mainnet");
      expect(mockQueryTransfers).not.toHaveBeenCalled();
    });

    it("400s on a real network this deployment does not serve", async () => {
      // A different fix from a typo: the caller needs a deployment that indexes
      // it, so the message names what this one actually has.
      process.env.NETWORKS = "testnet";

      const res = await request(createApp())
        .get(`/transfers/incoming/${ALICE}?network=mainnet`)
        .expect(400);

      expect(res.body.error).toContain('Network "mainnet" is not enabled');
      expect(res.body.error).toContain("Enabled networks: testnet");
      expect(mockQueryTransfers).not.toHaveBeenCalled();
    });

    it("rejects before touching the database, never with empty results", async () => {
      // Returning [] would read as "no such transfers" rather than "this
      // process has never indexed that chain".
      const res = await request(createApp())
        .get(`/transfers/incoming/${ALICE}?network=solana`)
        .expect(400);

      expect(res.body).not.toHaveProperty("transfers");
      expect(mockQueryTransfers).not.toHaveBeenCalled();
    });

    it("rejects an invalid selector on the health routes too", async () => {
      await request(createApp()).get("/status?network=nope").expect(400);
      await request(createApp()).get("/readyz?network=nope").expect(400);
    });
  });

  describe("/status", () => {
    it("reports the selected network and scopes its ledger fields to it", async () => {
      const res = await request(createApp()).get("/status?network=mainnet").expect(200);

      expect(res.body.network).toBe("mainnet");
      expect(mockGetLastIndexedLedger).toHaveBeenCalledWith("mainnet");
      expect(mockGetLatestLedger).toHaveBeenCalledWith("mainnet");
    });
  });

  describe("/readyz", () => {
    it("reports per-network health for every enabled network", async () => {
      const res = await request(createApp()).get("/readyz").expect(200);

      expect(res.body.network).toBe("testnet");
      expect(Object.keys(res.body.networks).sort()).toEqual(["mainnet", "testnet"]);
      expect(res.body.networks.testnet.checks).toEqual({
        db: true,
        rpc: true,
        indexerCaughtUp: true,
      });
      expect(res.body.networks.mainnet.checks.rpc).toBe(true);
    });

    it("shows one network degraded while the other stays healthy", async () => {
      // The whole point of per-network health: a single merged verdict cannot
      // say which chain is behind.
      mockGetLatestLedger.mockImplementation(async (net?: string) => {
        if (net === "mainnet") throw new Error("mainnet RPC down");
        return 1050;
      });

      const res = await request(createApp()).get("/readyz").expect(200);

      expect(res.body.networks.testnet.checks.rpc).toBe(true);
      expect(res.body.networks.mainnet.checks.rpc).toBe(false);
      // Top-level still describes the selected network, which is healthy.
      expect(res.body.status).toBe("healthy");
    });

    it("degrades the top-level verdict when the selected network is the broken one", async () => {
      mockGetLatestLedger.mockImplementation(async (net?: string) => {
        if (net === "mainnet") throw new Error("mainnet RPC down");
        return 1050;
      });

      const res = await request(createApp()).get("/readyz?network=mainnet").expect(200);

      expect(res.body.network).toBe("mainnet");
      expect(res.body.status).toBe("degraded");
      expect(res.body.stale).toBe(true);
    });

    it("still 503s for every network when the database is down", async () => {
      mockQueryRaw.mockRejectedValue(new Error("db down"));

      const res = await request(createApp()).get("/readyz").expect(503);

      expect(res.body.status).toBe("down");
      expect(res.body.networks.testnet.checks.db).toBe(false);
      expect(res.body.networks.mainnet.checks.db).toBe(false);
    });
  });

  describe("stale-read staleness is per network", () => {
    it("does not mark testnet reads stale because mainnet RPC is down", async () => {
      mockGetLatestLedger.mockImplementation(async (net?: string) => {
        if (net === "mainnet") throw new Error("mainnet RPC down");
        return 1050;
      });

      const app = createApp();
      const mainnet = await request(app).get(`/transfers/incoming/${ALICE}?network=mainnet`);
      const testnet = await request(app).get(`/transfers/incoming/${ALICE}?network=testnet`);

      expect(mainnet.headers["x-data-stale"]).toBe("true");
      expect(testnet.headers["x-data-stale"]).toBeUndefined();
    });
  });
});
