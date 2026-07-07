import { Router, Request, Response, NextFunction } from "express";
import { format as csvFormat } from "@fast-csv/format";
import { prisma, toDisplayAmount } from "../db";
import os from "os";
import path from "path";
import fs from "fs";

// How many rows we fetch per DB round-trip. Keeps memory flat.
const BATCH_SIZE = 500;

// ── Shared: parse query params into a Prisma where clause ────────────────────
function buildWhere(query: Record<string, unknown>) {
  const {
    address,
    contractId,
    fromLedger,
    toLedger,
    fromDate,
    toDate,
    eventType,
  } = query;

  const where: Record<string, unknown> = {};

  if (address) {
    where.OR = [{ fromAddress: address }, { toAddress: address }];
  }
  if (contractId) where.contractId = contractId;
  if (eventType) {
    const types = String(eventType).split(",").map((s) => s.trim()).filter(Boolean);
    if (types.length) where.eventType = { in: types };
  }

  const ledgerRange: Record<string, number> = {};
  if (fromLedger) ledgerRange.gte = parseInt(String(fromLedger), 10);
  if (toLedger)   ledgerRange.lte = parseInt(String(toLedger), 10);
  if (Object.keys(ledgerRange).length) where.ledger = ledgerRange;

  const dateRange: Record<string, Date> = {};
  if (fromDate) dateRange.gte = new Date(String(fromDate));
  if (toDate)   dateRange.lte = new Date(String(toDate));
  if (Object.keys(dateRange).length) where.ledgerClosedAt = dateRange;

  return where;
}

// ── Shared: async generator that yields rows in batches via cursor ────────────
async function* streamTransfers(where: Record<string, unknown>) {
  let lastId: number | undefined = undefined;

  while (true) {
    const rows: Awaited<ReturnType<typeof prisma.tokenTransfer.findMany>> = await prisma.tokenTransfer.findMany({
      where,
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(lastId !== undefined ? { cursor: { id: lastId }, skip: 1 } : {}),
    });

    if (rows.length === 0) break;

    for (const row of rows) {
      yield row;
    }

    if (rows.length < BATCH_SIZE) break;
    lastId = rows[rows.length - 1].id;
  }
}

// ── CSV endpoint ─────────────────────────────────────────────────────────────
async function handleCsvExport(req: Request, res: Response, next: NextFunction) {
  try {
    const where = buildWhere(req.query as Record<string, unknown>);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=\"transfers.csv\"");
    res.setHeader("Transfer-Encoding", "chunked");

    const csvStream = csvFormat({ headers: true });
    csvStream.pipe(res);

    for await (const row of streamTransfers(where)) {
      csvStream.write({
        id:              row.id,
        contractId:      row.contractId,
        eventType:       row.eventType,
        fromAddress:     row.fromAddress ?? "",
        toAddress:       row.toAddress ?? "",
        amount:          row.amount,
        displayAmount:   toDisplayAmount(row.amount),
        ledger:          row.ledger,
        ledgerClosedAt:  row.ledgerClosedAt.toISOString(),
        txHash:          row.txHash,
        eventId:         row.eventId,
        isSac:           row.isSac ?? false,
        createdAt:       row.createdAt.toISOString(),
      });
    }

    csvStream.end();
  } catch (err) {
    next(err);
  }
}

// ── Parquet endpoint ─────────────────────────────────────────────────────────
async function handleParquetExport(req: Request, res: Response, next: NextFunction) {
  // parquetjs-lite is a CommonJS module — require() avoids ESM interop issues
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const parquet = require("parquetjs-lite");

  const tmpFile = path.join(os.tmpdir(), `transfers-${Date.now()}-${Math.random().toString(36).slice(2)}.parquet`);

  try {
    const where = buildWhere(req.query as Record<string, unknown>);

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

    for await (const row of streamTransfers(where)) {
      await writer.appendRow({
        id:             row.id,
        contractId:     row.contractId,
        eventType:      row.eventType,
        fromAddress:    row.fromAddress ?? null,
        toAddress:      row.toAddress ?? null,
        amount:         row.amount,
        displayAmount:  toDisplayAmount(row.amount),
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

// ── Router ───────────────────────────────────────────────────────────────────
export function createExportsRouter(): Router {
  const router = Router();
  router.get("/transfers.csv",     handleCsvExport);
  router.get("/transfers.parquet", handleParquetExport);
  return router;
}
