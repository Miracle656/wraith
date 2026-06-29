import { Router } from "express";
import { prisma } from "../db";

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
    [contractId, limit, offset],
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
      const { bucket, contractId } = req.params;
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
      const offset = parseInt(req.query.offset as string) || 0;

      if (!["1m", "1h", "1d"].includes(bucket)) {
        return res
          .status(400)
          .json({ error: "Invalid bucket: must be 1m, 1h, or 1d" });
      }

      if (!contractId.match(/^C[A-Z2-7]{55}$/)) {
        return res.status(400).json({ error: "Invalid contract ID format" });
      }

      const candles = await queryCandlesFromAggregate(
        bucket as "1m" | "1h" | "1d",
        contractId,
        limit,
        offset,
      );

      res.json({ bucket, contractId, candles });
    } catch (err) {
      console.error("[candles] Query failed:", err);
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
    } catch (err) {
      console.error("[candles] Refresh failed:", err);
      res.status(500).json({ error: "Failed to refresh candles" });
    }
  });

  return router;
}
