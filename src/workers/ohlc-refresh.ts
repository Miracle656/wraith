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
    const [result1m, result1h, result1d] = await Promise.all([
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
  } catch (err) {
    const duration = Date.now() - start;
    console.error("[ohlc] Refresh failed:", err);
    throw new Error(
      `OHLC refresh failed after ${duration}ms: ${(err as Error).message}`,
    );
  }
}

export function startOhlcRefreshWorker(
  interval_ms: number = 60_000,
): () => void {
  const intervalId = setInterval(async () => {
    try {
      const result = await refreshOhlcAggregates();
      console.log(
        `[ohlc] Refreshed aggregates (${result.duration_ms}ms): 1m=${result.oneMinute.inserted}, 1h=${result.oneHour.inserted}, 1d=${result.oneDay.inserted}`,
      );
    } catch (err) {
      console.error("[ohlc] Refresh error:", err);
    }
  }, interval_ms);

  return () => clearInterval(intervalId);
}
