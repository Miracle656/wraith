import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { queryTransfers, queryAllTransfers, queryByTxHash, querySummary, getLastIndexedLedger, prisma } from "./db";
import { getLatestLedger } from "./rpc";
import { getIndexerStats } from "./indexer";
import { getAllCachedTokens } from "./tokenCache";

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10),
  max: parseInt(process.env.RATE_LIMIT_MAX ?? "60", 10),
  standardHeaders: true,   // Sends `RateLimit-*` headers
  legacyHeaders: false,    // Disables `X-RateLimit-*` headers
  message: { error: "Too many requests, please try again later." },
});

// ── Amount formatting ─────────────────────────────────────────────────────────
const STROOPS = 10_000_000n;

/**
 * Convert a raw i128 decimal string (stroops) to a human-readable 7-decimal
 * string. Uses BigInt arithmetic to avoid floating-point precision loss.
 * e.g. "10000000000" → "1000.0000000"
 */
export function toDisplayAmount(amount: string): string {
  const raw = BigInt(amount);
  const abs = raw < 0n ? -raw : raw;
  const integer = abs / STROOPS;
  const remainder = abs % STROOPS;
  const sign = raw < 0n ? "-" : "";
  return `${sign}${integer}.${String(remainder).padStart(7, "0")}`;
}

const withDisplay = <T extends { amount: string }>(t: T) => ({
  ...t,
  displayAmount: toDisplayAmount(t.amount),
});

const VALID_EVENT_TYPES = new Set(["transfer", "mint", "burn", "clawback"]);

// ── CSV utilities ─────────────────────────────────────────────────────────────
/**
 * Escape a value for CSV output.
 * If the value contains comma, quote, or newline, wrap in quotes and escape inner quotes.
 */
function escapeCSVValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Format a row of values as a CSV line.
 */
function formatCSVRow(values: unknown[]): string {
  return values.map(escapeCSVValue).join(",");
}

export function createApp(): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(limiter);

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const parseIntParam = (val: unknown, fallback: number): number => {
    const n = parseInt(String(val), 10);
    return isNaN(n) ? fallback : n;
  };


  /**
   * Parse a comma-separated eventType param (e.g. "transfer,mint").
   * Returns the array on success, sends a 400 and returns null on invalid values.
   */
  const parseEventTypes = (val: unknown, res: Response): string[] | null | undefined => {
    if (val === undefined || val === "") return undefined;
    const types = String(val).split(",").map((s) => s.trim()).filter(Boolean);
    const invalid = types.filter((t) => !VALID_EVENT_TYPES.has(t));
    if (invalid.length) {
      res.status(400).json({
        error: `Invalid eventType: "${invalid.join('", "')}". Valid values: transfer, mint, burn, clawback.`,
      });
      return null;
    }
    return types;
  };

  /**
   * Parse an ISO 8601 date string.
   * Returns undefined when absent, a Date when valid, null when invalid
   * (also sends a 400 so the caller should return immediately).
   */
  const parseDateParam = (val: unknown, res: Response): Date | null | undefined => {
    if (val === undefined || val === "") return undefined;
    const d = new Date(String(val));
    if (isNaN(d.getTime())) {
      res.status(400).json({ error: `Invalid date: "${val}". Expected ISO 8601 (e.g. 2025-01-01T00:00:00Z).` });
      return null;
    }
    return d;
  };

  // ── GET /healthz — K8s/Render liveness probe ─────────────────────────────────
  /**
   * Returns 200 as long as the process is alive.
   * Used by orchestrators to decide whether to restart the container.
   */
  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  // ── GET /readyz — K8s/Render readiness probe ─────────────────────────────────
  /**
   * Returns 200 only when:
   *   - Database connection is alive
   *   - Stellar RPC is reachable
   *   - Indexer lag is within acceptable threshold
   *
   * Query params:
   *   maxLag  — max acceptable ledger lag (default: 100)
   *
   * Returns 503 if any check fails.
   */
  app.get("/readyz", async (_req: Request, res: Response) => {
    const maxLag = parseInt(String(_req.query.maxLag), 10) || 100;
    const checks: Record<string, boolean> = {};

    try {
      // DB check
      await prisma.$queryRaw`SELECT 1`;
      checks.db = true;
    } catch {
      checks.db = false;
    }

    try {
      // RPC check
      const latest = await getLatestLedger();
      checks.rpc = latest > 0;
    } catch {
      checks.rpc = false;
    }

    try {
      // Indexer lag check
      const [lastIndexed, latest] = await Promise.all([
        getLastIndexedLedger(),
        getLatestLedger(),
      ]);
      const lag = lastIndexed !== null ? latest - lastIndexed : Infinity;
      checks.indexerCaughtUp = lag <= maxLag;
    } catch {
      checks.indexerCaughtUp = false;
    }

    const allHealthy = Object.values(checks).every(Boolean);

    if (!allHealthy) {
      res.status(503).json({ ok: false, checks });
    } else {
      res.json({ ok: true, checks });
    }
  });

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
  
  // ── GET /tokens ─────────────────────────────────────────────────────────────
  /**
   * Returns a list of all tokens encountered and cached by the indexer.
   */
  app.get("/tokens", (_req: Request, res: Response) => {
    const tokens = getAllCachedTokens();
    res.json({ ok: true, tokens });
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
        const { contractId, fromLedger, toLedger, fromDate, toDate, eventType, limit, offset } = req.query;

        const fromDateVal = parseDateParam(fromDate, res);
        if (fromDateVal === null) return;
        const toDateVal = parseDateParam(toDate, res);
        if (toDateVal === null) return;
        const eventTypes = parseEventTypes(eventType, res);
        if (eventTypes === null) return;

        const lim = parseIntParam(limit, 50);
        const off = parseIntParam(offset, 0);

        const result = await queryTransfers({
          address,
          direction: "incoming",
          contractId: contractId as string | undefined,
          fromLedger: fromLedger ? parseIntParam(fromLedger, 0) : undefined,
          toLedger: toLedger ? parseIntParam(toLedger, 0) : undefined,
          fromDate: fromDateVal,
          toDate: toDateVal,
          eventTypes,
          limit: lim,
          offset: off,
        });

        res.json({ ...result, transfers: result.transfers.map(withDisplay), limit: lim, offset: off });
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
        const { contractId, fromLedger, toLedger, fromDate, toDate, eventType, limit, offset } = req.query;

        const fromDateVal = parseDateParam(fromDate, res);
        if (fromDateVal === null) return;
        const toDateVal = parseDateParam(toDate, res);
        if (toDateVal === null) return;
        const eventTypes = parseEventTypes(eventType, res);
        if (eventTypes === null) return;

        const lim = parseIntParam(limit, 50);
        const off = parseIntParam(offset, 0);

        const result = await queryTransfers({
          address,
          direction: "outgoing",
          contractId: contractId as string | undefined,
          fromLedger: fromLedger ? parseIntParam(fromLedger, 0) : undefined,
          toLedger: toLedger ? parseIntParam(toLedger, 0) : undefined,
          fromDate: fromDateVal,
          toDate: toDateVal,
          eventTypes,
          limit: lim,
          offset: off,
        });

        res.json({ ...result, transfers: result.transfers.map(withDisplay), limit: lim, offset: off });
      } catch (err) {
        next(err);
      }
    }
  );

  // ── GET /transfers/address/:address ─────────────────────────────────────────
  /**
   * All token transfers sent or received by `address`, merged and sorted by
   * ledger descending. Each record includes a `direction` field
   * ("incoming" | "outgoing").
   *
   * Query params:
   *   contractId  — filter to a specific token contract
   *   fromLedger  — inclusive lower bound
   *   toLedger    — inclusive upper bound
   *   limit       — page size (max 200, default 50)
   *   offset      — pagination offset (default 0)
   *
   * Response:
   *   { total, limit, offset, transfers: [{ ...fields, direction }] }
   */
  app.get(
    "/transfers/address/:address",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { address } = req.params;
        const { contractId, fromLedger, toLedger, fromDate, toDate, eventType, limit, offset } = req.query;

        const fromDateVal = parseDateParam(fromDate, res);
        if (fromDateVal === null) return;
        const toDateVal = parseDateParam(toDate, res);
        if (toDateVal === null) return;
        const eventTypes = parseEventTypes(eventType, res);
        if (eventTypes === null) return;

        const lim = parseIntParam(limit, 50);
        const off = parseIntParam(offset, 0);

        const result = await queryAllTransfers({
          address,
          contractId: contractId as string | undefined,
          fromLedger: fromLedger ? parseIntParam(fromLedger, 0) : undefined,
          toLedger: toLedger ? parseIntParam(toLedger, 0) : undefined,
          fromDate: fromDateVal,
          toDate: toDateVal,
          eventTypes,
          limit: lim,
          offset: off,
        });

        res.json({ ...result, transfers: result.transfers.map(withDisplay), limit: lim, offset: off });
      } catch (err) {
        next(err);
      }
    }
  );

  // ── GET /transfers/address/:address/export.csv ──────────────────────────────
  /**
   * Export all token transfers for `address` as a downloadable CSV file.
   * Re-uses the same filtering logic as /transfers/address/:address but returns
   * a CSV file instead of JSON. Caps at 10,000 rows to avoid memory issues.
   *
   * Query params (same as /transfers/address/:address):
   *   contractId  — filter to a specific token contract
   *   fromLedger  — inclusive lower bound
   *   toLedger    — inclusive upper bound
   *   fromDate    — ISO 8601 inclusive lower bound on ledgerClosedAt
   *   toDate      — ISO 8601 inclusive upper bound on ledgerClosedAt
   *   eventType   — comma-separated event types (transfer, mint, burn, clawback)
   *
   * Response: CSV file with columns: date, type, from, to, amount, token, ledger
   */
  app.get(
    "/transfers/address/:address/export.csv",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { address } = req.params;
        const { contractId, fromLedger, toLedger, fromDate, toDate, eventType } = req.query;

        const fromDateVal = parseDateParam(fromDate, res);
        if (fromDateVal === null) return;
        const toDateVal = parseDateParam(toDate, res);
        if (toDateVal === null) return;
        const eventTypes = parseEventTypes(eventType, res);
        if (eventTypes === null) return;

        // Always fetch with offset=0 and enforce a 10,000 row limit for CSV export
        const result = await queryAllTransfers({
          address,
          contractId: contractId as string | undefined,
          fromLedger: fromLedger ? parseIntParam(fromLedger, 0) : undefined,
          toLedger: toLedger ? parseIntParam(toLedger, 0) : undefined,
          fromDate: fromDateVal,
          toDate: toDateVal,
          eventTypes,
          limit: 10000,
          offset: 0,
        });

        // Build CSV content
        const csvLines: string[] = [];

        // Add CSV header
        csvLines.push(formatCSVRow(["date", "type", "from", "to", "amount", "token", "ledger"]));

        // Add data rows
        for (const transfer of result.transfers) {
          const displayAmount = toDisplayAmount(transfer.amount);
          csvLines.push(
            formatCSVRow([
              transfer.ledgerClosedAt.toISOString(),
              transfer.eventType,
              transfer.fromAddress || "",
              transfer.toAddress || "",
              displayAmount,
              transfer.contractId,
              transfer.ledger,
            ])
          );
        }

        const csvContent = csvLines.join("\n");

        // Set response headers for CSV download
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="transfers-${address}.csv"`);
        res.send(csvContent);
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
        res.json({ transfers: transfers.map(withDisplay) });
      } catch (err) {
        next(err);
      }
    }
  );

  // ── GET /summary/:address ────────────────────────────────────────────────────
  /**
   * Aggregate token stats for `address`, grouped by contractId.
   *
   * Query params:
   *   contractId  — filter to a specific token contract
   *   fromDate    — ISO 8601 inclusive lower bound on ledgerClosedAt
   *   toDate      — ISO 8601 inclusive upper bound on ledgerClosedAt
   *
   * Response:
   *   { address, window: { fromDate, toDate }, tokens: [{ contractId,
   *     totalReceived, totalSent, netFlow,
   *     displayTotalReceived, displayTotalSent, displayNetFlow, txCount }] }
   */
  app.get(
    "/summary/:address",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { address } = req.params;
        const { contractId, fromDate, toDate } = req.query;

        const fromDateVal = parseDateParam(fromDate, res);
        if (fromDateVal === null) return;
        const toDateVal = parseDateParam(toDate, res);
        if (toDateVal === null) return;

        const rows = await querySummary({
          address,
          contractId: contractId as string | undefined,
          fromDate: fromDateVal,
          toDate: toDateVal,
        });

        const tokens = rows.map((row) => {
          const received = BigInt(row.totalReceived);
          const sent = BigInt(row.totalSent);
          const net = received - sent;
          return {
            contractId: row.contractId,
            totalReceived: row.totalReceived,
            totalSent: row.totalSent,
            netFlow: net.toString(),
            displayTotalReceived: toDisplayAmount(row.totalReceived),
            displayTotalSent: toDisplayAmount(row.totalSent),
            displayNetFlow: toDisplayAmount(net.toString()),
            txCount: Number(row.txCount),
          };
        });

        res.json({
          address,
          window: {
            fromDate: fromDateVal?.toISOString() ?? null,
            toDate: toDateVal?.toISOString() ?? null,
          },
          tokens,
        });
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
