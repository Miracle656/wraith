import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { jsonApiMiddleware } from "./middleware/jsonapi";
import { queryHostFnLogs } from "./indexer/host-fn-log";
import { queryTransfers, queryAllTransfers, queryByTxHash, querySummary, queryNftTransfers, getNftOwner, getNftMetadata, getLastIndexedLedger, prisma } from "./db";
import { getLatestLedger } from "./rpc";
import { getIndexerStats } from "./indexer";
import { createAccountsRouter } from "./api/accounts";
import { createWebhooksRouter } from "./api/webhooks";
import { createGraphQLMiddleware } from "./graphql/server";
import { createPopularAssetsRouter } from "./routes/assets/popular";
import { createExportsRouter } from "./routes/exports";
import { createSearchRouter } from "./routes/search";
import { cacheMiddleware } from "./cache/redis";
import {
  hostFnQuerySchema,
  nftOwnerParamsSchema,
  nftTransfersQuerySchema,
  txHashParamsSchema,
  readyzQuerySchema,
  summaryQuerySchema,
  transferQuerySchema,
} from "./openapi/schemas";
import { parseOr400 } from "./openapi/validation";

// ─── RPC Health Check Cache ───────────────────────────────────────────────
let cachedRpcHealth: { healthy: boolean; timestamp: number } | null = null;
const RPC_HEALTH_CACHE_TTL_MS = 3000;

export function clearRpcHealthCache(): void {
  cachedRpcHealth = null;
}

export async function checkRpcHealth(): Promise<boolean> {
  const now = Date.now();
  if (cachedRpcHealth && now - cachedRpcHealth.timestamp < RPC_HEALTH_CACHE_TTL_MS) {
    return cachedRpcHealth.healthy;
  }

  try {
    const latest = await getLatestLedger();
    const healthy = typeof latest === "number" && latest > 0;
    cachedRpcHealth = { healthy, timestamp: now };
    return healthy;
  } catch {
    cachedRpcHealth = { healthy: false, timestamp: now };
    return false;
  }
}

// ─── Rate limiting ─────────────────────────────────────────────────────────
// Skip rate limiting in test environment to avoid 429 errors during tests
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10),
  max: parseInt(process.env.RATE_LIMIT_MAX ?? "60", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  skip: () => process.env.NODE_ENV === "test",
});

// ─── Response cache (opt-in via CACHE_ENABLED) ─────────────────────────────
// Per-route TTLs: popular-asset rollups tolerate more staleness than search.
const POPULAR_CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_POPULAR_MS ?? "60000", 10);
const SEARCH_CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_SEARCH_MS ?? "15000", 10);

// ─── Amount formatting ────────────────────────────────────────────────────
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

function parseSelectQuery(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

const VALID_EVENT_TYPES = new Set(["transfer", "mint", "burn", "clawback"]);

// ─── CSV utilities ─────────────────────────────────────────────────────────
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
  app.use(jsonApiMiddleware);
  app.use(limiter);

  // ─── Stale read middleware ──────────────────────────────────────────
  // Attaches X-Data-Stale and X-As-Of-Ledger headers plus `stale` / `as_of_ledger`
  // body parameters when serving DB data during an RPC outage.
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" || req.path === "/healthz") {
      return next();
    }

    try {
      const rpcHealthy = await checkRpcHealth();
      if (!rpcHealthy) {
        const lastIndexed = await getLastIndexedLedger().catch(() => null);
        res.setHeader("X-Data-Stale", "true");
        if (lastIndexed !== null) {
          res.setHeader("X-As-Of-Ledger", String(lastIndexed));
        }

        const originalJson = res.json.bind(res);
        res.json = (body: any) => {
          if (body && typeof body === "object" && !Array.isArray(body) && body.error === undefined) {
            if (body.stale === undefined) {
              body.stale = true;
            }
            if (body.as_of_ledger === undefined && lastIndexed !== null) {
              body.as_of_ledger = lastIndexed;
            }
          }
          return originalJson(body);
        };
      }
    } catch {
      // Fall through cleanly
    }
    next();
  });

  // ─── Accounts routes ─────────────────────────────────────────────────────
  app.use("/accounts", createAccountsRouter());

  // ─── Webhook subscription management ─────────────────────────────────────
  app.use("/webhooks", createWebhooksRouter());
  app.use("/graphql", createGraphQLMiddleware());

  // ─── Assets routes ───────────────────────────────────────────────────────
  app.use("/assets", cacheMiddleware({ ttlMs: POPULAR_CACHE_TTL_MS }), createPopularAssetsRouter());

  // ─── Export routes ───────────────────────────────────────────────────────
  app.use("/", createExportsRouter());

  // ─── Fuzzy search across accounts, assets, and contracts ──────────────────
  app.use("/search", cacheMiddleware({ ttlMs: SEARCH_CACHE_TTL_MS }), createSearchRouter());

  // ─── Helpers ─────────────────────────────────────────────────────────────
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

  // ─── GET /healthz — K8s/Render liveness probe ───────────────────────────
  /**
   * Returns 200 as long as the process is alive.
   * Used by orchestrators to decide whether to restart the container.
   */
  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  // ─── GET /readyz — K8s/Render readiness probe ───────────────────────────
  /**
   * Returns 200 when database connection is alive.
   * Degrades to 200 with status "degraded" when only RPC/indexer is down.
   * Returns 503 with status "down" only when DB is dead.
   */
  app.get("/readyz", async (_req: Request, res: Response) => {
    const parsed = parseOr400(readyzQuerySchema, _req.query, res);
    if (!parsed) return;
    const { maxLag } = parsed;
    const checks: Record<string, boolean> = {};

    try {
      // DB check
      await prisma.$queryRaw`SELECT 1`;
      checks.db = true;
    } catch {
      checks.db = false;
    }

    let latest: number | null = null;
    try {
      // RPC check
      latest = await getLatestLedger();
      checks.rpc = typeof latest === "number" && latest > 0;
    } catch {
      checks.rpc = false;
    }

    let lastIndexed: number | null = null;
    try {
      lastIndexed = await getLastIndexedLedger();
      const lag = (lastIndexed !== null && latest !== null) ? latest - lastIndexed : Infinity;
      checks.indexerCaughtUp = lag <= maxLag;
    } catch {
      checks.indexerCaughtUp = false;
    }

    const allHealthy = Object.values(checks).every(Boolean);

    if (!checks.db) {
      res.status(503).json({ ok: false, status: "down", checks });
    } else {
      const status = allHealthy ? "healthy" : "degraded";
      if (!allHealthy) {
        res.setHeader("X-Data-Stale", "true");
        if (lastIndexed !== null) {
          res.setHeader("X-As-Of-Ledger", String(lastIndexed));
        }
      }
      res.json({
        ok: true,
        status,
        checks,
        ...(lastIndexed !== null ? { as_of_ledger: lastIndexed } : {}),
        ...(allHealthy ? {} : { stale: true }),
      });
    }
  });

  // ─── GET /status ─────────────────────────────────────────────────────────
  /**
   * Returns indexer health status: "healthy", "degraded", or "down".
   */
  app.get("/status", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [lastIndexedResult, latestLedgerResult] = await Promise.allSettled([
        getLastIndexedLedger(),
        getLatestLedger(),
      ]);

      if (lastIndexedResult.status === "rejected") {
        res.status(503).json({ ok: false, status: "down", error: "Database unavailable" });
        return;
      }

      const lastIndexedLedger = lastIndexedResult.value;
      const rpcSuccess = latestLedgerResult.status === "fulfilled" && typeof latestLedgerResult.value === "number";
      const latestLedger = rpcSuccess ? latestLedgerResult.value : null;
      const stats = getIndexerStats();

      if (rpcSuccess && latestLedger !== null) {
        res.json({
          ok: true,
          status: "healthy",
          lastIndexedLedger,
          latestLedger,
          lagLedgers: latestLedger - (lastIndexedLedger ?? latestLedger),
          ...stats,
        });
      } else {
        res.setHeader("X-Data-Stale", "true");
        if (lastIndexedLedger !== null) {
          res.setHeader("X-As-Of-Ledger", String(lastIndexedLedger));
        }
        res.json({
          ok: true,
          status: "degraded",
          stale: true,
          as_of_ledger: lastIndexedLedger ?? undefined,
          lastIndexedLedger,
          latestLedger: null,
          lagLedgers: null,
          ...stats,
        });
      }
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /transfers/incoming/:address ────────────────────────────────────
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
        const parsed = parseOr400(transferQuerySchema, { ...req.params, ...req.query }, res);
        if (!parsed) return;
        const { address, contractId, fromLedger, toLedger, fromDate, toDate, eventType, limit, offset, cursor, $filter, $select, token } = parsed as {
          address: string;
          contractId?: string;
          fromLedger?: number;
          toLedger?: number;
          fromDate?: Date;
          toDate?: Date;
          eventType?: string[];
          limit: number;
          offset: number;
          cursor?: string;
          $filter?: string;
          $select?: string[];
          token?: string;
        };

        const result = await queryTransfers({
          address,
          direction: "incoming",
          contractId,
          token,
          filter: $filter,
          select: $select as string[] | undefined,
          cursor,
          fromLedger,
          toLedger,
          fromDate,
          toDate,
          eventTypes: eventType as string[] | undefined,
          limit,
          offset,
        });

        res.json({
          ...result,
          transfers: result.transfers.map((transfer) => {
            if (transfer && typeof (transfer as { amount?: unknown }).amount === "string") {
              return withDisplay(transfer as { amount: string });
            }
            return transfer;
          }),
          limit,
          offset,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /transfers/outgoing/:address ────────────────────────────────────
  /**
   * All token transfers sent by `address`.
   * Same query params & response shape as /incoming/:address.
   */
  app.get(
    "/transfers/outgoing/:address",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(transferQuerySchema, { ...req.params, ...req.query }, res);
        if (!parsed) return;
        const { address, contractId, fromLedger, toLedger, fromDate, toDate, eventType, limit, offset, cursor, $filter, $select, token } = parsed as {
          address: string;
          contractId?: string;
          fromLedger?: number;
          toLedger?: number;
          fromDate?: Date;
          toDate?: Date;
          eventType?: string[];
          limit: number;
          offset: number;
          cursor?: string;
          $filter?: string;
          $select?: string[];
          token?: string;
        };

        const result = await queryTransfers({
          address,
          direction: "outgoing",
          contractId,
          token,
          filter: $filter,
          select: $select as string[] | undefined,
          cursor,
          fromLedger,
          toLedger,
          fromDate,
          toDate,
          eventTypes: eventType as string[] | undefined,
          limit,
          offset,
        });

        res.json({
          ...result,
          transfers: result.transfers.map((transfer) => {
            if (transfer && typeof (transfer as { amount?: unknown }).amount === "string") {
              return withDisplay(transfer as { amount: string });
            }
            return transfer;
          }),
          limit,
          offset,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /transfers/address/:address ─────────────────────────────────────
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
        const parsed = parseOr400(transferQuerySchema, { ...req.params, ...req.query }, res);
        if (!parsed) return;
        const { address, contractId, fromLedger, toLedger, fromDate, toDate, eventType, limit, offset, token, cursor, $filter, $select } = parsed as {
          address: string;
          contractId?: string;
          fromLedger?: number;
          toLedger?: number;
          fromDate?: Date;
          toDate?: Date;
          eventType?: string[];
          limit: number;
          offset: number;
          token?: string;
          cursor?: string;
          $filter?: string;
          $select?: string[];
        };

        const result = await queryAllTransfers({
          address,
          contractId,
          token,
          filter: $filter,
          select: $select as string[] | undefined,
          cursor,
          fromLedger,
          toLedger,
          fromDate,
          toDate,
          eventTypes: eventType as string[] | undefined,
          limit,
          offset,
        });

        res.json({
          ...result,
          transfers: result.transfers.map((transfer) => {
            if (transfer && typeof (transfer as { amount?: unknown }).amount === "string") {
              return withDisplay(transfer as { amount: string });
            }
            return transfer;
          }),
          limit,
          offset,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /transfers/address/:address/export.csv ───────────────────────────
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
        const parsed = parseOr400(
          transferQuerySchema.omit({ limit: true, offset: true, cursor: true, $filter: true, $select: true }),
          { ...req.params, ...req.query },
          res,
        );
        if (!parsed) return;
        const { address, contractId, fromLedger, toLedger, fromDate, toDate, eventType, token } = parsed as {
          address: string;
          contractId?: string;
          fromLedger?: number;
          toLedger?: number;
          fromDate?: Date;
          toDate?: Date;
          eventType?: string[];
          token?: string;
        };

        // Always fetch with offset=0 and enforce a 10,000 row limit for CSV export
        const result = await queryAllTransfers({
          address,
          contractId,
          token,
          fromLedger,
          toLedger,
          fromDate,
          toDate,
          eventTypes: eventType as string[] | undefined,
          limit: 10000,
          offset: 0,
        });

        // Build CSV content
        const csvLines: string[] = [];

        // Add CSV header
        csvLines.push(formatCSVRow(["date", "type", "from", "to", "amount", "token", "ledger"]));

        // Add data rows
        for (const transfer of result.transfers) {
          const t = transfer as Record<string, unknown>;
          const displayAmount = toDisplayAmount(String(t.amount ?? "0"));
          const closedAt = t.ledgerClosedAt instanceof Date
            ? t.ledgerClosedAt
            : new Date(String(t.ledgerClosedAt ?? 0));
          csvLines.push(
            formatCSVRow([
              closedAt.toISOString(),
              t.eventType,
              t.fromAddress || "",
              t.toAddress || "",
              displayAmount,
              t.contractId,
              t.ledger,
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

  // ─── GET /transfers/tx/:txHash ───────────────────────────────────────────
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
        const parsed = parseOr400(txHashParamsSchema, req.params, res);
        if (!parsed) return;
        const transfers = await queryByTxHash(parsed.txHash);
        res.json({ transfers: transfers.map(withDisplay) });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /summary/:address ───────────────────────────────────────────────
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
  const summaryHandler = async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(summaryQuerySchema, { ...req.params, ...req.query }, res);
        if (!parsed) return;
        const { address, contractId, fromDate, toDate } = parsed;

        const rows = await querySummary({
          address,
          contractId,
          fromDate,
          toDate,
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
            fromDate: fromDate?.toISOString() ?? null,
            toDate: toDate?.toISOString() ?? null,
          },
          tokens,
        });
      } catch (err) {
        next(err);
      }
    };

  app.get("/summary/:address", summaryHandler);
  app.get("/accounts/:address/summary", summaryHandler);

  // ─── GET /host-fn/:contractId ────────────────────────────────────────────
  /**
   * Query raw host-function invocation logs for a contract.
   *
   * Every contract event indexed by Wraith is stored here — not just SEP-41
   * token events — so downstream consumers can interpret arbitrary contracts.
   *
   * Query params:
   *   functionName  — filter by function name (e.g. "swap")
   *   limit         — max rows (default 50, hard cap 200)
   *   offset        — pagination offset (default 0)
   */
  app.get(
    "/host-fn/:contractId",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(hostFnQuerySchema, { ...req.params, ...req.query }, res);
        if (!parsed) return;
        const { contractId, functionName, limit, offset } = parsed;

        const { total, logs } = await queryHostFnLogs({
          contractId,
          functionName,
          limit,
          offset,
        });

        res.json({
          contractId,
          total,
          limit,
          offset,
          logs: logs.map((log) => ({
            ...log,
            gasUsed: log.gasUsed === null ? null : log.gasUsed.toString(),
          })),
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /nfts/transfers ─────────────────────────────────────────────────
  /**
   * Query CAP-46 NFT transfer events.
   *
   * Query params:
   *   contract    — filter to a specific NFT contract (C...)
   *   token_id    — filter to a specific token identifier
   *   address     — filter to transfers where from OR to equals this address
   *   fromLedger  — inclusive lower ledger bound
   *   toLedger    — inclusive upper ledger bound
   *   limit       — page size (max 200, default 50)
   *   offset      — pagination offset (default 0)
   *
   * Response:
   *   { total, limit, offset, transfers: [...] }
   */
  app.get(
    "/nfts/transfers",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(nftTransfersQuerySchema, req.query, res);
        if (!parsed) return;
        const { contract, token_id, address, fromLedger, toLedger, limit, offset, cursor, $filter, $select } = parsed as {
          contract?: string;
          token_id?: string;
          address?: string;
          fromLedger?: number;
          toLedger?: number;
          limit: number;
          offset: number;
          cursor?: string;
          $filter?: string;
          $select?: string[];
        };

        const result = await queryNftTransfers({
          contractId: contract,
          tokenId: token_id,
          address,
          filter: $filter,
          select: $select as string[] | undefined,
          cursor,
          fromLedger,
          toLedger,
          limit,
          offset,
        });

        res.json({ ...result, limit, offset });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /nfts/owners/:contract/:token_id ────────────────────────────────
  /**
   * Return the current owner of an NFT (the toAddress of its most recent transfer).
   * Also includes any cached metadata for the token.
   *
   * Path params:
   *   contract  — NFT contract address (C...)
   *   token_id  — Token identifier
   *
   * Response:
   *   { contract, token_id, owner, metadata: { name, tokenUri } | null }
   */
  app.get(
    "/nfts/owners/:contract/:token_id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(nftOwnerParamsSchema, req.params, res);
        if (!parsed) return;
        const { contract, token_id } = parsed;

        const [owner, metadata] = await Promise.all([
          getNftOwner(contract, token_id),
          getNftMetadata(contract, token_id),
        ]);

        if (owner === null) {
          res.status(404).json({
            error: "Token not found. No transfers indexed for this contract/token_id.",
          });
          return;
        }

        res.json({
          contract,
          token_id,
          owner,
          metadata: metadata
            ? { name: metadata.name, tokenUri: metadata.tokenUri }
            : null,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── 404 handler ─────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // ─── Global error handler ────────────────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api] Unhandled error:", err);
    res.status(500).json({ error: err.message ?? "Internal server error" });
  });

  return app;
}
