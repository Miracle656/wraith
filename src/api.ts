import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { queryTransfers, queryByTxHash, getLastIndexedLedger } from "./db";
import { getLatestLedger } from "./rpc";
import { getIndexerStats } from "./indexer";

export function createApp(): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // ── Helper ──────────────────────────────────────────────────────────────────
  const parseIntParam = (val: unknown, fallback: number): number => {
    const n = parseInt(String(val), 10);
    return isNaN(n) ? fallback : n;
  };

  // ── GET /status ─────────────────────────────────────────────────────────────
  /**
   * Returns the indexer health status.
   *
   * Response:
   *   { lastIndexedLedger, latestLedger, lagLedgers, uptimeSeconds, totalIndexed }
   */
  app.get("/status", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [lastIndexedLedger, latestLedger] = await Promise.all([
        getLastIndexedLedger(),
        getLatestLedger(),
      ]);
      const stats = getIndexerStats();
      res.json({
        ok: true,
        lastIndexedLedger,
        latestLedger,
        lagLedgers: latestLedger - (lastIndexedLedger ?? latestLedger),
        ...stats,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /transfers/incoming/:address ────────────────────────────────────────
  /**
   * All token transfers received by `address`.
   *
   * Query params:
   *   contractId  — filter to a specific token contract
   *   fromLedger  — inclusive lower bound
   *   toLedger    — inclusive upper bound
   *   limit       — page size (max 200, default 50)
   *   offset      — pagination offset (default 0)
   *
   * Response:
   *   { total, limit, offset, transfers: [...] }
   */
  app.get(
    "/transfers/incoming/:address",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { address } = req.params;
        const { contractId, fromLedger, toLedger, limit, offset } = req.query;

        const result = await queryTransfers({
          address,
          direction: "incoming",
          contractId: contractId as string | undefined,
          fromLedger: fromLedger ? parseIntParam(fromLedger, 0) : undefined,
          toLedger: toLedger ? parseIntParam(toLedger, 0) : undefined,
          limit: parseIntParam(limit, 50),
          offset: parseIntParam(offset, 0),
        });

        res.json({ ...result, limit: parseIntParam(limit, 50), offset: parseIntParam(offset, 0) });
      } catch (err) {
        next(err);
      }
    }
  );

  // ── GET /transfers/outgoing/:address ────────────────────────────────────────
  /**
   * All token transfers sent by `address`.
   * Same query params & response shape as /incoming/:address.
   */
  app.get(
    "/transfers/outgoing/:address",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { address } = req.params;
        const { contractId, fromLedger, toLedger, limit, offset } = req.query;

        const result = await queryTransfers({
          address,
          direction: "outgoing",
          contractId: contractId as string | undefined,
          fromLedger: fromLedger ? parseIntParam(fromLedger, 0) : undefined,
          toLedger: toLedger ? parseIntParam(toLedger, 0) : undefined,
          limit: parseIntParam(limit, 50),
          offset: parseIntParam(offset, 0),
        });

        res.json({ ...result, limit: parseIntParam(limit, 50), offset: parseIntParam(offset, 0) });
      } catch (err) {
        next(err);
      }
    }
  );

  // ── GET /transfers/tx/:txHash ────────────────────────────────────────────────
  /**
   * All token events emitted within a given transaction.
   *
   * Response:
   *   { transfers: [...] }
   */
  app.get(
    "/transfers/tx/:txHash",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const transfers = await queryByTxHash(req.params.txHash);
        res.json({ transfers });
      } catch (err) {
        next(err);
      }
    }
  );

  // ── 404 handler ──────────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // ── Global error handler ─────────────────────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api] Unhandled error:", err);
    res.status(500).json({ error: err.message ?? "Internal server error" });
  });

  return app;
}
