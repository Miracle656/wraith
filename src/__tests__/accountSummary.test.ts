/**
 * Unit tests for the account-summary aggregate logic.
 *
 * We test the in-memory accumulation logic directly by importing a helper,
 * and the API route using supertest with the DB layer mocked.
 */

import { createApp } from "../api";
import supertest from "supertest";

// ── Mock DB module ────────────────────────────────────────────────────────────
jest.mock("../db", () => ({
  ...jest.requireActual("../db"),
  getAccountSummary: jest.fn(),
  queryTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [] }),
  queryAllTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [] }),
  queryByTxHash: jest.fn().mockResolvedValue([]),
  querySummary: jest.fn().mockResolvedValue([]),
  getLastIndexedLedger: jest.fn().mockResolvedValue(1000),
  prisma: { $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]) },
}));

jest.mock("../rpc", () => ({
  getLatestLedger: jest.fn().mockResolvedValue(1002),
  validateNetworkConfig: jest.fn(),
}));

jest.mock("../indexer", () => ({
  getIndexerStats: jest.fn().mockReturnValue({ startedAt: "2024-01-01T00:00:00Z", uptimeSeconds: 0, totalIndexed: 0 }),
}));

const { getAccountSummary } = require("../db");

const ALICE = "GDWCO35QUYQLGO6P7OLW4BZWNMMGGUWNPLRVPLCBVG7YNVDZKUDIW4KN";
const CONTRACT = "CBC42KFZO33TYVFDOUXFRWXYYXHFGH7W5GM4IJQSXKGFINKL2XPP4XTE";

describe("GET /accounts/:address/summary", () => {
  const app = createApp();

  it("returns 200 with one asset row per contract", async () => {
    getAccountSummary.mockResolvedValueOnce([
      {
        contractId:     CONTRACT,
        totalSent:      "5000000000",
        totalReceived:  "10000000000",
        net:            "5000000000",
        txCount:        3,
        lastActivityAt: new Date("2024-06-01T00:00:00Z"),
      },
    ]);

    const res = await supertest(app).get(`/accounts/${ALICE}/summary`);

    expect(res.status).toBe(200);
    expect(res.body.address).toBe(ALICE);
    expect(res.body.assets).toHaveLength(1);

    const asset = res.body.assets[0];
    expect(asset.contractId).toBe(CONTRACT);
    expect(asset.totalSent).toBe("5000000000");
    expect(asset.totalReceived).toBe("10000000000");
    expect(asset.net).toBe("5000000000");
    expect(asset.txCount).toBe(3);
    // Display amounts should be formatted with 7 decimals
    expect(asset.displayTotalSent).toBe("500.0000000");
    expect(asset.displayTotalReceived).toBe("1000.0000000");
  });

  it("returns empty assets array when address has no transfers", async () => {
    getAccountSummary.mockResolvedValueOnce([]);

    const res = await supertest(app).get(`/accounts/${ALICE}/summary`);

    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(0);
  });

  it("passes contractId query param to DB layer", async () => {
    getAccountSummary.mockResolvedValueOnce([]);

    await supertest(app).get(`/accounts/${ALICE}/summary?contractId=${CONTRACT}`);

    expect(getAccountSummary).toHaveBeenCalledWith(ALICE, CONTRACT);
  });

  it("returns account transfers and supports token filter", async () => {
    const transfer = {
      id: 1,
      contractId: CONTRACT,
      eventType: "transfer",
      fromAddress: "GBOBADDRESSABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGH",
      toAddress: ALICE,
      amount: "10000000",
      ledger: 1234,
      ledgerClosedAt: new Date("2025-01-01T00:00:00Z"),
      txHash: "txhash-123",
      eventId: "evt-123",
      createdAt: new Date("2025-01-01T00:00:01Z"),
      direction: "incoming",
    };

    const { queryAllTransfers } = require("../db");
    queryAllTransfers.mockResolvedValueOnce({
      total: 1,
      transfers: [transfer],
      nextCursor: null,
    });

    const res = await supertest(app)
      .get(`/accounts/${ALICE}/transfers`)
      .query({ token: CONTRACT, limit: "10", offset: "2", cursor: "cursor-1", $select: "contractId,direction" });

    expect(res.status).toBe(200);
    expect(res.body.transfers[0].displayAmount).toBe("1.0000000");
    expect(queryAllTransfers).toHaveBeenCalledWith(
      expect.objectContaining({
        address: ALICE,
        token: CONTRACT,
        limit: 10,
        offset: 2,
        cursor: "cursor-1",
        select: ["contractId", "direction"],
      })
    );
  });

  it("returns 400 for invalid token filter on account transfers", async () => {
    const { queryAllTransfers } = require("../db");

    const res = await supertest(app)
      .get(`/accounts/${ALICE}/transfers`)
      .query({ token: "GINVALIDTOKENADDRESS" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid token address/i);
    expect(queryAllTransfers).not.toHaveBeenCalled();
  });

  it("returns multiple asset rows for multi-token accounts", async () => {
    const CONTRACT2 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    getAccountSummary.mockResolvedValueOnce([
      { contractId: CONTRACT,  totalSent: "1000", totalReceived: "2000", net: "1000",  txCount: 1, lastActivityAt: new Date() },
      { contractId: CONTRACT2, totalSent: "500",  totalReceived: "0",    net: "-500",  txCount: 1, lastActivityAt: new Date() },
    ]);

    const res = await supertest(app).get(`/accounts/${ALICE}/summary`);

    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(2);
  });
});
