import request from "supertest";
import express from "express";

// ── Mock the db singleton before importing the router ───────────────────────
jest.mock("../../db", () => ({
  prisma: {
    accountSummary: { findMany: jest.fn() },
    tokenTransfer: { findMany: jest.fn() },
    hostFnLog: { findMany: jest.fn() },
  },
}));

import { prisma } from "../../db";
import {
  createSearchRouter,
  mergeSearchHits,
  normalizeQuery,
  type RawAccountHit,
  type RawAssetHit,
  type RawContractHit,
} from "../../routes/search";

const mockAccounts = prisma.accountSummary.findMany as jest.Mock;
const mockAssets = prisma.tokenTransfer.findMany as jest.Mock;
const mockContracts = prisma.hostFnLog.findMany as jest.Mock;

const ACCOUNT = "GACCOUNTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ASSET = "CASSETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const CONTRACT = "CCONTRACTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

function buildApp() {
  const app = express();
  app.use("/search", createSearchRouter());
  // Minimal error handler so the route's `next(err)` path is observable.
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    },
  );
  return app;
}

beforeEach(() => {
  mockAccounts.mockResolvedValue([]);
  mockAssets.mockResolvedValue([]);
  mockContracts.mockResolvedValue([]);
});

describe("GET /search", () => {
  it("returns typed hits across accounts, assets and contracts", async () => {
    mockAccounts.mockResolvedValue([
      { address: ACCOUNT, lastActivityAt: new Date("2026-01-01T00:00:00.000Z") },
    ]);
    mockAssets.mockResolvedValue([{ contractId: ASSET, isSac: true }]);
    mockContracts.mockResolvedValue([{ contractId: CONTRACT }]);

    const res = await request(buildApp()).get("/search").query({ q: "C" });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.results).toEqual([
      { type: "account", value: ACCOUNT, lastActivityAt: "2026-01-01T00:00:00.000Z" },
      { type: "asset", value: ASSET, isSac: true },
      { type: "contract", value: CONTRACT },
    ]);
  });

  it("upper-cases the query for prefix matching", async () => {
    await request(buildApp()).get("/search").query({ q: "  gacc  " });

    expect(mockAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ where: { address: { startsWith: "GACC" } } }),
    );
    expect(mockAssets).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contractId: { startsWith: "GACC" } } }),
    );
  });

  it("caps results at 10 across types", async () => {
    mockAccounts.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        address: `GACC${i}`,
        lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
      })),
    );
    mockAssets.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ contractId: `CASSET${i}`, isSac: false })),
    );

    const res = await request(buildApp()).get("/search").query({ q: "G" });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(10);
  });

  it("rejects a missing query with 400", async () => {
    const res = await request(buildApp()).get("/search");
    expect(res.status).toBe(400);
    expect(mockAccounts).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only query with 400", async () => {
    const res = await request(buildApp()).get("/search").query({ q: "   " });
    expect(res.status).toBe(400);
  });

  it("surfaces database errors via the error handler", async () => {
    mockAccounts.mockRejectedValue(new Error("db down"));
    const res = await request(buildApp()).get("/search").query({ q: "G" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("db down");
  });
});

describe("normalizeQuery", () => {
  it("trims and upper-cases", () => {
    expect(normalizeQuery("  cabc ")).toBe("CABC");
    expect(normalizeQuery("GdEf")).toBe("GDEF");
  });
});

describe("mergeSearchHits", () => {
  const account: RawAccountHit = {
    address: ACCOUNT,
    lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("de-duplicates a value shared by asset and contract, preferring asset", () => {
    const assets: RawAssetHit[] = [{ contractId: ASSET, isSac: true }];
    const contracts: RawContractHit[] = [{ contractId: ASSET }];

    const hits = mergeSearchHits([account], assets, contracts, 10);

    expect(hits).toHaveLength(2);
    expect(hits.filter((h) => h.value === ASSET)).toEqual([
      { type: "asset", value: ASSET, isSac: true },
    ]);
  });

  it("respects the limit", () => {
    const assets: RawAssetHit[] = Array.from({ length: 20 }, (_, i) => ({
      contractId: `C${i}`,
      isSac: false,
    }));
    expect(mergeSearchHits([], assets, [], 10)).toHaveLength(10);
  });
});
