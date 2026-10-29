/**
 * #324: behaviour of src/utils/errors.ts through the real global error
 * handler in src/api.ts.
 *
 * The handler is reached by making a real route (GET /transfers/incoming/:address)
 * fail inside its try block. `queryTransfers` is mocked to reject, so the error
 * travels the same path a production failure would: route -> next(err) ->
 * global handler -> response.
 */
import request from "supertest";
import { createApp, clearRpcHealthCache } from "../api";
import { HttpError, newCorrelationId } from "../utils/errors";

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
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest
    .fn()
    .mockReturnValue({ startedAt: "2024-01-01T00:00:00Z", uptimeSeconds: 100, totalIndexed: 50 }),
  isIndexerRunning: jest.fn().mockReturnValue(true),
  isIndexerStopped: jest.fn().mockReturnValue(false),
  getIndexerUnstartedReason: jest.fn().mockReturnValue(undefined),
}));

import { queryTransfers, getLastIndexedLedger, prisma } from "../db";
import { getLatestLedger } from "../rpc";

const mockQueryTransfers = queryTransfers as jest.MockedFunction<typeof queryTransfers>;
const mockGetLastIndexedLedger = getLastIndexedLedger as jest.MockedFunction<typeof getLastIndexedLedger>;
const mockGetLatestLedger = getLatestLedger as jest.MockedFunction<typeof getLatestLedger>;
const mockQueryRaw = prisma.$queryRaw as jest.MockedFunction<typeof prisma.$queryRaw>;

const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ROUTE = `/transfers/incoming/${ALICE}`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("utils/errors", () => {
  it("HttpError keeps its status, message and name, and is an Error", () => {
    const err = new HttpError(422, "fromLedger must not exceed toLedger");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(422);
    expect(err.message).toBe("fromLedger must not exceed toLedger");
    expect(err.name).toBe("HttpError");
  });

  it("newCorrelationId returns distinct UUID v4 values", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = newCorrelationId();
      expect(id).toMatch(UUID_V4);
      ids.add(id);
    }
    expect(ids.size).toBe(1000);
  });
});

describe("global error handler (#324)", () => {
  const app = createApp();
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    clearRpcHealthCache();
    mockGetLastIndexedLedger.mockResolvedValue(1000);
    mockGetLatestLedger.mockResolvedValue(1000);
    mockQueryRaw.mockResolvedValue([{ 1: 1 }]);
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it.each([
    [400, "invalid_request"],
    [404, "invalid_request"],
    [409, "invalid_request"],
    [422, "invalid_request"],
    [503, "internal_error"],
  ])("an HttpError(%i) reaches the client with its own status and message", async (status, code) => {
    const message = `deliberate ${status} for the caller`;
    mockQueryTransfers.mockRejectedValue(new HttpError(status, message));

    const res = await request(app).get(ROUTE);

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: message, code });
    // A deliberate error is not an incident: no correlation id, no error log.
    expect(res.body).not.toHaveProperty("correlationId");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("masks a non-HttpError instead of surfacing its message verbatim", async () => {
    const secret = "connect ECONNREFUSED postgres://wraith:hunter2@db.internal:5432/wraith";
    mockQueryTransfers.mockRejectedValue(new Error(secret));

    const res = await request(app).get(ROUTE);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
    expect(res.body.code).toBe("internal_error");
    expect(res.text).not.toContain("hunter2");
    expect(res.text).not.toContain("postgres://");
    expect(res.text).not.toContain("ECONNREFUSED");
    // The detail is kept for operators, in the log only.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][1]).toBeInstanceOf(Error);
    expect((consoleError.mock.calls[0][1] as Error).message).toBe(secret);
  });

  it("masks a thrown non-Error value too", async () => {
    mockQueryTransfers.mockRejectedValue("raw string from a driver");

    const res = await request(app).get(ROUTE);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
    expect(res.text).not.toContain("raw string from a driver");
  });

  it("puts the same correlation id in the response and the log line", async () => {
    mockQueryTransfers.mockRejectedValue(new Error("boom"));

    const res = await request(app).get(ROUTE);

    const correlationId = res.body.correlationId;
    expect(correlationId).toMatch(UUID_V4);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain(correlationId);
  });

  it("gives each unhandled failure its own correlation id", async () => {
    mockQueryTransfers.mockRejectedValue(new Error("boom"));

    const responses = [];
    for (let i = 0; i < 5; i++) {
      responses.push(await request(app).get(ROUTE));
    }

    const ids = responses.map((r) => r.body.correlationId);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id, i) => {
      expect(String(consoleError.mock.calls[i][0])).toContain(id);
    });
  });
});
