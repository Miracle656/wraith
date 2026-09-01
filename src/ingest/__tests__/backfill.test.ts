jest.mock("../../indexer/sources", () => ({
  createSourceSwitcherWithConfig: jest.fn(() => ({
    getLatestLedger: jest.fn(),
    fetchEvents: jest.fn(),
    getActiveSourceName: jest.fn(),
  })),
}));

jest.mock("../../rpc", () => ({
  validateNetworkConfig: jest.fn(),
  fetchEventsSafe: jest.fn(),
  getLatestLedger: jest.fn(),
}));

jest.mock("../../db", () => ({
  getBackfillCursor: jest.fn(),
  setBackfillCursor: jest.fn(),
  clearBackfillCursor: jest.fn(),
  upsertTransfers: jest.fn(),
  upsertNftTransfers: jest.fn(),
  getLastIndexedLedger: jest.fn(),
  setLastIndexedLedger: jest.fn(),
  prisma: { $disconnect: jest.fn() },
}));

jest.mock("../../indexer/host-fn-log", () => ({
  parseHostFnEvent: jest.fn(),
  upsertHostFnLogs: jest.fn(),
}));

jest.mock("../../ingester/nft", () => ({
  isNftTransferEvent: jest.fn(() => false),
  parseNftEvents: jest.fn(() => []),
}));

jest.mock("../../decoder", () => ({
  parseEvents: jest.fn(() => []),
}));

import { chunkRange, runBackfill } from "../backfill";
import { getBackfillCursor, setBackfillCursor, clearBackfillCursor, upsertTransfers } from "../../db";
import type { BackfillCursorState } from "../../db";

const mockGetBackfillCursor = getBackfillCursor as jest.MockedFunction<typeof getBackfillCursor>;
const mockSetBackfillCursor = setBackfillCursor as jest.MockedFunction<typeof setBackfillCursor>;
const mockClearBackfillCursor = clearBackfillCursor as jest.MockedFunction<typeof clearBackfillCursor>;
const mockUpsertTransfers = upsertTransfers as jest.MockedFunction<typeof upsertTransfers>;

describe("chunkRange", () => {
  it("splits a range into equal-sized chunks", () => {
    const result = chunkRange(1, 10, 3);
    expect(result).toEqual([
      { start: 1, end: 4 },
      { start: 4, end: 7 },
      { start: 7, end: 10 },
    ]);
  });

  it("returns a single chunk when range fits in one", () => {
    const result = chunkRange(100, 105, 10);
    expect(result).toEqual([{ start: 100, end: 105 }]);
  });

  it("returns empty array for empty range", () => {
    expect(chunkRange(10, 10, 5)).toEqual([]);
    expect(chunkRange(10, 5, 5)).toEqual([]);
  });

  it("handles exact multiples", () => {
    const result = chunkRange(0, 100, 25);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ start: 0, end: 25 });
    expect(result[3]).toEqual({ start: 75, end: 100 });
  });

  it("handles chunkSize of 1", () => {
    const result = chunkRange(5, 8, 1);
    expect(result).toEqual([
      { start: 5, end: 6 },
      { start: 6, end: 7 },
      { start: 7, end: 8 },
    ]);
  });
});

describe("runBackfill", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STELLAR_NETWORK = "testnet";
  });

  it("clears cursor when range is already complete", async () => {
    const cursor: BackfillCursorState = {
      startLedger: 100,
      endLedger: 200,
      nextLedger: 200,
    };
    mockGetBackfillCursor.mockResolvedValue(cursor);

    await runBackfill({ fromLedger: 100, toLedger: 200 });

    expect(mockClearBackfillCursor).toHaveBeenCalled();
    expect(mockSetBackfillCursor).not.toHaveBeenCalled();
  });

  it("resumes from cursor when range matches", async () => {
    const cursor: BackfillCursorState = {
      startLedger: 100,
      endLedger: 200,
      nextLedger: 150,
    };
    mockGetBackfillCursor.mockResolvedValue(cursor);

    await runBackfill({ fromLedger: 100, toLedger: 200, chunkSize: 64 });

    // Backfill should process from chunk starting at 150, not from 100
    const expectedChunks = chunkRange(150, 200, 64);
    expect(expectedChunks).toHaveLength(1);
    expect(expectedChunks[0]).toEqual({ start: 150, end: 200 });

    // setBackfillCursor should have been called with nextLedger=200 (completed)
    expect(mockSetBackfillCursor).toHaveBeenCalled();
    const call = mockSetBackfillCursor.mock.calls[mockSetBackfillCursor.mock.calls.length - 1][0];
    expect(call.nextLedger).toBe(200);
    expect(call.startLedger).toBe(100);
    expect(call.endLedger).toBe(200);
  });

  it("respects force flag to override existing cursor", async () => {
    const cursor: BackfillCursorState = {
      startLedger: 100,
      endLedger: 200,
      nextLedger: 180,
    };
    mockGetBackfillCursor.mockResolvedValue(cursor);

    await runBackfill({ fromLedger: 300, toLedger: 400, force: true });

    // After processing completes, cursor should be at endLedger
    expect(mockSetBackfillCursor).toHaveBeenCalled();
    const lastCall = mockSetBackfillCursor.mock.calls[mockSetBackfillCursor.mock.calls.length - 1][0];
    expect(lastCall.startLedger).toBe(300);
    expect(lastCall.endLedger).toBe(400);
    expect(lastCall.nextLedger).toBe(400);

    // Verify cursor was cleared at the end
    expect(mockClearBackfillCursor).toHaveBeenCalled();
  });

  it("does not process if cursor range differs without force", async () => {
    const cursor: BackfillCursorState = {
      startLedger: 100,
      endLedger: 200,
      nextLedger: 150,
    };
    mockGetBackfillCursor.mockResolvedValue(cursor);

    await runBackfill({ fromLedger: 300, toLedger: 400, force: false });

    expect(mockUpsertTransfers).not.toHaveBeenCalled();
    expect(mockClearBackfillCursor).not.toHaveBeenCalled();
  });

  it("starts fresh when no cursor exists", async () => {
    mockGetBackfillCursor.mockResolvedValue(null);

    await runBackfill({ fromLedger: 1, toLedger: 10, chunkSize: 10 });

    expect(mockSetBackfillCursor).toHaveBeenCalled();
    const setCall = mockSetBackfillCursor.mock.calls[0][0];
    expect(setCall.nextLedger).toBe(10);
  });

  it("aborts cleanly when signal is received", async () => {
    mockGetBackfillCursor.mockResolvedValue(null);
    const signal = AbortSignal.abort();

    await runBackfill({ fromLedger: 1, toLedger: 1000, chunkSize: 10, signal });

    expect(mockUpsertTransfers).not.toHaveBeenCalled();
  });

  it("does not call IndexerState functions", async () => {
    const { getLastIndexedLedger, setLastIndexedLedger } = await import("../../db");

    mockGetBackfillCursor.mockResolvedValue(null);

    await runBackfill({ fromLedger: 1, toLedger: 10, chunkSize: 10 });

    expect(getLastIndexedLedger).not.toHaveBeenCalled();
    expect(setLastIndexedLedger).not.toHaveBeenCalled();
  });
});
