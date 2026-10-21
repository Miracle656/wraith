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

  return router;
}
