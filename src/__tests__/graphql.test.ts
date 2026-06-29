import { createHash } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../api";
import { resetPersistedQueryCache } from "../graphql/persisted";

jest.mock("../db", () => ({
  getAccountSummary: jest.fn().mockResolvedValue([]),
  getLastIndexedLedger: jest.fn().mockResolvedValue(1),
  getNftMetadata: jest.fn(),
  getNftOwner: jest.fn(),
  prisma: {
    $queryRaw: jest.fn(),
    webhookSubscription: {
      create: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
    },
    webhookDelivery: {
      findMany: jest.fn(),
    },
  },
  queryAllTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
  queryByTxHash: jest.fn().mockResolvedValue([]),
  queryNftTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
  querySummary: jest.fn().mockResolvedValue([]),
  queryTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
}));

jest.mock("../rpc", () => ({
  getLatestLedger: jest.fn().mockResolvedValue(1),
}));

jest.mock("../indexer", () => ({
  getIndexerStats: jest.fn().mockReturnValue({ uptimeSeconds: 0, totalIndexed: 0 }),
}));

jest.mock("../indexer/host-fn-log", () => ({
  queryHostFnLogs: jest.fn().mockResolvedValue({ total: 0, logs: [] }),
}));

describe("GraphQL server plugins", () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  afterEach(() => {
    process.env = { ...originalEnv };
    resetPersistedQueryCache();

    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an over-cost query at /graphql", async () => {
    process.env.GRAPHQL_MAX_COST = "1";

    const res = await request(createApp())
      .post("/graphql")
      .send({ query: "{ health { ok version } }" });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors?.[0]?.message).toBe("Internal server error");
  });

  it("blocks non-allowlisted production queries at /graphql", async () => {
    process.env.NODE_ENV = "production";
    const res = await request(createApp())
      .post("/graphql")
      .send({ query: "{ health { ok } }" });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors?.[0]?.message).toBe("Internal server error");
  });

  it("runs an allowlisted persisted query in production", async () => {
    process.env.NODE_ENV = "production";

    const query = "{ health { ok } }";
    const hash = createHash("sha256").update(query).digest("hex");
    const tempDir = mkdtempSync(path.join(tmpdir(), "wraith-persisted-"));
    tempDirs.push(tempDir);

    process.env.PERSISTED_QUERIES_PATH = path.join(tempDir, "persisted-queries.json");
    writeFileSync(process.env.PERSISTED_QUERIES_PATH, JSON.stringify({ [hash]: query }));
    resetPersistedQueryCache();

    const res = await request(createApp())
      .post("/graphql")
      .send({ extensions: { persistedQuery: { sha256Hash: hash } } });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.health.ok).toBe(true);
  });
});
