jest.mock("../db", () => ({ prisma: { $queryRaw: jest.fn() } }));

import { prisma } from "../db";
import { refreshOhlcAggregates, startOhlcRefreshWorker } from "../workers/ohlc-refresh";

const mockQueryRaw = prisma.$queryRaw as jest.Mock;

function pendingQuery() {
  let resolve!: (rows: Array<{ rows_inserted: number; rows_updated: number }>) => void;
  const promise = new Promise<Array<{ rows_inserted: number; rows_updated: number }>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("OHLC refresh worker", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockQueryRaw.mockReset().mockResolvedValue([]);
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("refreshes all three buckets and preserves inserted and updated counts", async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ rows_inserted: 1, rows_updated: 2 }])
      .mockResolvedValueOnce([{ rows_inserted: 3, rows_updated: 4 }])
      .mockResolvedValueOnce([{ rows_inserted: 5, rows_updated: 6 }]);

    await expect(refreshOhlcAggregates()).resolves.toEqual({
      oneMinute: { inserted: 1, updated: 2 },
      oneHour: { inserted: 3, updated: 4 },
      oneDay: { inserted: 5, updated: 6 },
      duration_ms: 0,
    });
    expect(mockQueryRaw).toHaveBeenCalledTimes(3);
    const queries = mockQueryRaw.mock.calls.map(([parts]) => parts.join(""));
    expect(queries[0]).toContain("ohlc.refresh_candles_1m()");
    expect(queries[1]).toContain("ohlc.refresh_candles_1h()");
    expect(queries[2]).toContain("ohlc.refresh_candles_1d()");
  });

  it("reports zero counts when the refresh functions return no rows", async () => {
    await expect(refreshOhlcAggregates()).resolves.toEqual({
      oneMinute: { inserted: 0, updated: 0 },
      oneHour: { inserted: 0, updated: 0 },
      oneDay: { inserted: 0, updated: 0 },
      duration_ms: 0,
    });
  });

  it("does not expose a database error in a thrown error or log", async () => {
    mockQueryRaw.mockRejectedValueOnce(
      new Error("connection failed: postgresql://admin:secret@private-db/wraith"),
    );

    await expect(refreshOhlcAggregates()).rejects.toThrow(/^OHLC refresh failed$/);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("waits for the configured interval and stops scheduling when disposed", async () => {
    const stop = startOhlcRefreshWorker(5_000);

    expect(mockQueryRaw).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(4_999);
    expect(mockQueryRaw).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockQueryRaw).toHaveBeenCalledTimes(3);

    stop();
    stop();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockQueryRaw).toHaveBeenCalledTimes(3);
  });

  it("skips overlapping ticks while a refresh is still running", async () => {
    const pending = pendingQuery();
    mockQueryRaw.mockReturnValueOnce(pending.promise);
    const stop = startOhlcRefreshWorker(1_000);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(mockQueryRaw).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(mockQueryRaw).toHaveBeenCalledTimes(3);

    pending.resolve([]);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(mockQueryRaw).toHaveBeenCalledTimes(6);
    stop();
  });

  it("waits for remaining bucket queries after a failure and then retries safely", async () => {
    const pending = pendingQuery();
    mockQueryRaw
      .mockRejectedValueOnce(new Error("postgresql://admin:secret@private-db/wraith"))
      .mockReturnValueOnce(pending.promise);
    const stop = startOhlcRefreshWorker(1_000);

    await jest.advanceTimersByTimeAsync(1_000);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(mockQueryRaw).toHaveBeenCalledTimes(3);
    expect(console.error).not.toHaveBeenCalled();

    pending.resolve([]);
    await jest.advanceTimersByTimeAsync(0);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      "[ohlc] Refresh failed; retrying on the next interval.",
    );
    await jest.advanceTimersByTimeAsync(1_000);
    expect(mockQueryRaw).toHaveBeenCalledTimes(6);
    expect(console.log).toHaveBeenCalledTimes(1);
    stop();
  });
});
