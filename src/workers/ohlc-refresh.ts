import { prisma } from "../db";

export interface OhlcRefreshResult {
  oneMinute: { inserted: number; updated: number };
  oneHour: { inserted: number; updated: number };
  oneDay: { inserted: number; updated: number };
  duration_ms: number;
}

export async function refreshOhlcAggregates(): Promise<OhlcRefreshResult> {
  const start = Date.now();

  try {
    // Wait for every bucket even if one fails, so the worker cannot start a
    // new refresh while queries from the previous run are still pending.
    const results = await Promise.allSettled([
      prisma.$queryRaw<Array<{ rows_inserted: number; rows_updated: number }>>`
        SELECT rows_inserted, rows_updated FROM ohlc.refresh_candles_1m()
      `,
      prisma.$queryRaw<Array<{ rows_inserted: number; rows_updated: number }>>`
        SELECT rows_inserted, rows_updated FROM ohlc.refresh_candles_1h()
      `,
      prisma.$queryRaw<Array<{ rows_inserted: number; rows_updated: number }>>`
        SELECT rows_inserted, rows_updated FROM ohlc.refresh_candles_1d()
      `,
    ]);
    const [result1m, result1h, result1d] = results.map((result) => {
      if (result.status === "rejected") throw new Error("OHLC refresh failed");
      return result.value;
    });

    const duration = Date.now() - start;

    return {
      oneMinute: result1m[0]
        ? {
            inserted: result1m[0].rows_inserted,
            updated: result1m[0].rows_updated,
          }
        : { inserted: 0, updated: 0 },
      oneHour: result1h[0]
        ? {
            inserted: result1h[0].rows_inserted,
            updated: result1h[0].rows_updated,
          }
        : { inserted: 0, updated: 0 },
      oneDay: result1d[0]
        ? {
            inserted: result1d[0].rows_inserted,
            updated: result1d[0].rows_updated,
          }
        : { inserted: 0, updated: 0 },
      duration_ms: duration,
    };
  } catch {
    throw new Error("OHLC refresh failed");
  }
}

export function startOhlcRefreshWorker(
  interval_ms: number = 60_000,
): () => void {
  let running = false;
  const intervalId = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await refreshOhlcAggregates();
      console.log(
        `[ohlc] Refreshed aggregates (${result.duration_ms}ms): 1m=${result.oneMinute.inserted}, 1h=${result.oneHour.inserted}, 1d=${result.oneDay.inserted}`,
      );
    } catch {
      console.error("[ohlc] Refresh failed; retrying on the next interval.");
    } finally {
      running = false;
    }
  }, interval_ms);

  return () => clearInterval(intervalId);
}
