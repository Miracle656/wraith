import { Router, Request, Response, NextFunction } from "express";
import { format as csvFormat } from "@fast-csv/format";
import { prisma, toDisplayAmount } from "../db";
import os from "os";
import path from "path";
import fs from "fs";
import { z } from "zod";
import { requestNetwork } from "../middleware/network";
import { parseOr400 } from "../openapi/validation";
import type { Network } from "../network";
import { getCachedTokenDecimals } from "../tokenCache";

// How many rows we fetch per DB round-trip. Keeps memory flat.
const BATCH_SIZE = 500;

// Hard cap on rows returned per export request. Callers that need more should
// paginate with fromLedger/toLedger or apply a tighter date/address filter.
// The value is deliberately large enough to be useful but small enough to keep
// memory and response time predictable under load.
const ABSOLUTE_MAX_ROWS = 500_000;

/**
 * Default row cap, overridable per deployment with EXPORT_MAX_ROWS.
 *
 * Clamped to ABSOLUTE_MAX_ROWS rather than trusted: an env var is how an
 * operator lowers this without a release, and a mistyped one must not be able
 * to raise it past what the process can hold. A non-numeric value falls back
 * rather than becoming NaN, which would make every comparison below false.
 */
const DEFAULT_MAX_ROWS = Math.min(
  Number(process.env.EXPORT_MAX_ROWS) || 50_000,
  ABSOLUTE_MAX_ROWS,
);

// ── Query-param schema ────────────────────────────────────────────────────────
// Exported so the OpenAPI build can reference it.
export const exportQuerySchema = z.object({
  address:    z.string().trim().optional(),
  contractId: z.string().trim().optional(),
  fromLedger: z.coerce.number().int().min(0).optional(),
  toLedger:   z.coerce.number().int().min(0).optional(),
  fromDate:   z.string().datetime({ offset: true, message: "Invalid date — expected ISO 8601 (e.g. 2025-01-01T00:00:00Z)" })
                .transform((v) => new Date(v)).optional(),
  toDate:     z.string().datetime({ offset: true, message: "Invalid date — expected ISO 8601 (e.g. 2025-01-01T00:00:00Z)" })
                .transform((v) => new Date(v)).optional(),
  eventType:  z.string().trim().optional(),
  maxRows:    z.coerce.number().int()
                .min(1, "maxRows must be >= 1")
                .max(ABSOLUTE_MAX_ROWS, `maxRows must be <= ${ABSOLUTE_MAX_ROWS}`)
                .optional(),
});

type ExportQuery = z.infer<typeof exportQuerySchema>;

// ── Shared: build a Prisma where clause from validated params ─────────────────
function buildWhere(params: ExportQuery, network: Network) {
  const { address, contractId, fromLedger, toLedger, fromDate, toDate, eventType } = params;

  // Network first: an export must not leak rows from a chain the caller did
  // not ask for, and every filter below narrows within it.
  const where: Record<string, unknown> = { network };

  if (address) {
    where.OR = [{ fromAddress: address }, { toAddress: address }];
  }
  if (contractId) where.contractId = contractId;
  if (eventType) {
    const types = eventType.split(",").map((s) => s.trim()).filter(Boolean);
    if (types.length) where.eventType = { in: types };
  }

  const ledgerRange: Record<string, number> = {};
  if (fromLedger !== undefined) ledgerRange.gte = fromLedger;
  if (toLedger !== undefined)   ledgerRange.lte = toLedger;
  if (Object.keys(ledgerRange).length) where.ledger = ledgerRange;

  const dateRange: Record<string, Date> = {};
  if (fromDate) dateRange.gte = fromDate;
  if (toDate)   dateRange.lte = toDate;
  if (Object.keys(dateRange).length) where.ledgerClosedAt = dateRange;

  return where;
}

/**
 * Is there a row beyond the cap?
 *
 * Asked before any bytes are written, because that is the only time the answer
 * can still be put in a header. Detecting truncation mid-stream — by fetching
 * one extra row and then calling res.setHeader — throws ERR_HTTP_HEADERS_SENT:
 * the first csvStream.write has already flushed the response head. That throw
 * skips csvStream.end(), so the client is left holding a CSV body that never
 * terminates, and it happens only on the truncation path, which is the one case
 * the signalling exists for.
 *
 * One indexed query against the same filter, and cheaper than a COUNT because
 * it stops at the first row past the cap.
 */
async function hasRowsBeyond(where: Record<string, unknown>, max: number): Promise<boolean> {
  const beyond = await prisma.tokenTransfer.findMany({
    where,
    orderBy: { id: "asc" },
    skip: max,
    take: 1,
    select: { id: true },
  });
  return beyond.length > 0;
}

// ── Shared: async generator that yields rows in batches via cursor ────────────
// Stops once `limit` rows have been yielded so callers never pull more than
// they asked for regardless of DB size.
async function* streamTransfers(where: Record<string, unknown>, limit: number) {
  let lastId: number | undefined = undefined;
  let yielded = 0;

  while (yielded < limit) {
    const take = Math.min(BATCH_SIZE, limit - yielded);

    const rows: Awaited<ReturnType<typeof prisma.tokenTransfer.findMany>> =
      await prisma.tokenTransfer.findMany({
        where,
        orderBy: { id: "asc" },
        take,
        ...(lastId !== undefined ? { cursor: { id: lastId }, skip: 1 } : {}),
      });

    if (rows.length === 0) break;

    for (const row of rows) {
      yield row;
      yielded++;
    }

    if (rows.length < take) break;
    lastId = rows[rows.length - 1].id;
  }
}

// ── CSV endpoint ──────────────────────────────────────────────────────────────
async function handleCsvExport(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = parseOr400(exportQuerySchema, req.query, res);
    if (!parsed) return;

    const effectiveMax = parsed.maxRows ?? DEFAULT_MAX_ROWS;
    const network = requestNetwork(req);
    const where = buildWhere(parsed, network);

    // Before a single byte: once the body starts, headers can no longer be set.
    const truncated = await hasRowsBeyond(where, effectiveMax);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=\"transfers.csv\"");
    res.setHeader("Transfer-Encoding", "chunked");
    if (truncated) {
      res.setHeader("X-Truncated", "true");
      res.setHeader("X-Row-Limit", String(effectiveMax));
    }

    const csvStream = csvFormat({ headers: true });
    csvStream.pipe(res);

    for await (const row of streamTransfers(where, effectiveMax)) {
      csvStream.write({
        id:             row.id,
        contractId:     row.contractId,
        eventType:      row.eventType,
        fromAddress:    row.fromAddress ?? "",
        toAddress:      row.toAddress ?? "",
        amount:         row.amount,
        displayAmount:  toDisplayAmount(row.amount, getCachedTokenDecimals(row.contractId, network)),
        ledger:         row.ledger,
        ledgerClosedAt: row.ledgerClosedAt.toISOString(),
        txHash:         row.txHash,
        eventId:        row.eventId,
        isSac:          row.isSac ?? false,
        createdAt:      row.createdAt.toISOString(),
      });
    }

    csvStream.end();
  } catch (err) {
    next(err);
  }
}

// ── Parquet endpoint ──────────────────────────────────────────────────────────
async function handleParquetExport(req: Request, res: Response, next: NextFunction) {
  // parquetjs-lite is a CommonJS module — require() avoids ESM interop issues
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const parquet = require("parquetjs-lite");

  const tmpFile = path.join(
    os.tmpdir(),
    `transfers-${Date.now()}-${Math.random().toString(36).slice(2)}.parquet`,
  );

  try {
    const parsed = parseOr400(exportQuerySchema, req.query, res);
    if (!parsed) return;

    const effectiveMax = parsed.maxRows ?? DEFAULT_MAX_ROWS;
    const network = requestNetwork(req);
    const where = buildWhere(parsed, network);

    const schema = new parquet.ParquetSchema({
      id:             { type: "INT64" },
      contractId:     { type: "UTF8" },
      eventType:      { type: "UTF8" },
      fromAddress:    { type: "UTF8", optional: true },
      toAddress:      { type: "UTF8", optional: true },
      amount:         { type: "UTF8" },
      displayAmount:  { type: "UTF8" },
      ledger:         { type: "INT32" },
      ledgerClosedAt: { type: "UTF8" },
      txHash:         { type: "UTF8" },
      eventId:        { type: "UTF8" },
      isSac:          { type: "BOOLEAN", optional: true },
      createdAt:      { type: "UTF8" },
    });

    const writer = await parquet.ParquetWriter.openFile(schema, tmpFile);

    // Headers are set after the file is written here, so this could have been
    // detected mid-stream — but it goes through the same helper as CSV so the
    // two endpoints cannot answer differently about the same query.
    const truncated = await hasRowsBeyond(where, effectiveMax);

    for await (const row of streamTransfers(where, effectiveMax)) {
      await writer.appendRow({
        id:             row.id,
        contractId:     row.contractId,
        eventType:      row.eventType,
        fromAddress:    row.fromAddress ?? null,
        toAddress:      row.toAddress ?? null,
        amount:         row.amount,
        displayAmount:  toDisplayAmount(row.amount, getCachedTokenDecimals(row.contractId, network)),
        ledger:         row.ledger,
        ledgerClosedAt: row.ledgerClosedAt.toISOString(),
        txHash:         row.txHash,
        eventId:        row.eventId,
        isSac:          row.isSac ?? null,
        createdAt:      row.createdAt.toISOString(),
      });
    }

    await writer.close();

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", "attachment; filename=\"transfers.parquet\"");
    if (truncated) {
      res.setHeader("X-Truncated", "true");
      res.setHeader("X-Row-Limit", String(effectiveMax));
    }

    const fileStream = fs.createReadStream(tmpFile);
    fileStream.pipe(res);
    fileStream.on("end", () => fs.unlink(tmpFile, () => {}));
    fileStream.on("error", (err) => {
      fs.unlink(tmpFile, () => {});
      next(err);
    });
  } catch (err) {
    fs.unlink(tmpFile, () => {});
    next(err);
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
export function createExportsRouter(): Router {
  const router = Router();
  router.get("/transfers.csv",     handleCsvExport);
  router.get("/transfers.parquet", handleParquetExport);
  return router;
}
