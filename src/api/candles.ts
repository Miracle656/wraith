import { Router } from "express";
import { prisma } from "../db";
import { candlesParamsSchema, candlesQuerySchema } from "../openapi/schemas";
import { parseOr400 } from "../openapi/validation";

export interface Candle {
  timeBucket: string;
  contractId: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  txCount: number;
}

async function queryCandlesFromAggregate(
  bucket: "1m" | "1h" | "1d",
  contractId: string,
  limit = 100,
  offset = 0,
): Promise<Candle[]> {
  const table = `ohlc.candles_${bucket}`;

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      time_bucket: string | Date;
      contract_id: string;
      open_price: string;
      high_price: string;
      low_price: string;
      close_price: string;
      volume: string;
      tx_count: number;
    }>
  >(
    `
    SELECT
      time_bucket,
      contract_id,
      open_price,
      high_price,
      low_price,
      close_price,
      volume,
      tx_count
    FROM ${table}
    WHERE contract_id = $1
    ORDER BY time_bucket DESC
    LIMIT $2 OFFSET $3
    `,
    contractId,
    limit,
    offset,
  );

  return rows.map((row) => ({
    timeBucket:
      row.time_bucket instanceof Date
        ? row.time_bucket.toISOString()
        : row.time_bucket,
    contractId: row.contract_id,
    open: row.open_price,
    high: row.high_price,
    low: row.low_price,
    close: row.close_price,
    volume: row.volume,
    txCount: row.tx_count,
  }));
}

export function createCandlesRouter(): Router {
  const router = Router();

  router.get("/:bucket/:contractId", async (req, res) => {
    try {
      const params = parseOr400(candlesParamsSchema, req.params, res);
      if (!params) return;
      const query = parseOr400(candlesQuerySchema, req.query, res);
      if (!query) return;
      const { bucket, contractId } = params;
      const { limit, offset } = query;

      const candles = await queryCandlesFromAggregate(
        bucket,
        contractId,
        limit,
        offset,
      );

      res.json({ bucket, contractId, candles });
    } catch {
      console.error("[candles] Query failed");
      res.status(500).json({ error: "Failed to query candles" });
    }
  });

  router.post("/refresh", async (req, res) => {
    try {
      const [result1m, result1h, result1d] = await Promise.all([
        prisma.$queryRaw<
          Array<{ rows_inserted: number; rows_updated: number }>
        >`
          SELECT rows_inserted, rows_updated FROM ohlc.refresh_candles_1m()
        `,
        prisma.$queryRaw<
          Array<{ rows_inserted: number; rows_updated: number }>
        >`
          SELECT rows_inserted, rows_updated FROM ohlc.refresh_candles_1h()
        `,
        prisma.$queryRaw<
          Array<{ rows_inserted: number; rows_updated: number }>
        >`
          SELECT rows_inserted, rows_updated FROM ohlc.refresh_candles_1d()
        `,
      ]);

      res.json({
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
      });
    } catch {
      console.error("[candles] Refresh failed");
      res.status(500).json({ error: "Failed to refresh candles" });
    }
  });

  return router;
}
