/**
 * Backfill script — account_summaries
 *
 * Reads all existing TokenTransfer rows in batches and rebuilds the
 * AccountSummary table from scratch. Safe to run multiple times: the table
 * is truncated at the start so counts stay accurate.
 *
 * Usage:
 *   npx ts-node scripts/backfill-account-summaries.ts
 *
 * Environment variables:
 *   DATABASE_URL          — Postgres connection string (required)
 *   BACKFILL_BATCH_SIZE   — rows per page (default: 5000)
 */

import "dotenv/config";
import { prisma, upsertAccountSummaries } from "../src/db";
import type { TransferRecord } from "../src/db";

const BATCH_SIZE = parseInt(process.env.BACKFILL_BATCH_SIZE ?? "5000", 10);

async function main() {
  console.log("[backfill] Starting account summary backfill…");

  // Wipe existing aggregates so we don't double-count on re-runs
  const deleted = await prisma.accountSummary.deleteMany({});
  console.log(`[backfill] Cleared ${deleted.count} existing rows`);

  const total = await prisma.tokenTransfer.count();
  console.log(`[backfill] Total transfers to process: ${total}`);

  let offset = 0;
  let processed = 0;

  while (offset < total) {
    const batch = await prisma.tokenTransfer.findMany({
      orderBy: { id: "asc" },
      skip: offset,
      take: BATCH_SIZE,
    });

    if (batch.length === 0) break;

    // Cast to TransferRecord — schema fields are identical
    const records: TransferRecord[] = batch.map((row) => ({
      contractId:     row.contractId,
      eventType:      row.eventType,
      fromAddress:    row.fromAddress,
      toAddress:      row.toAddress,
      amount:         row.amount,
      ledger:         row.ledger,
      ledgerClosedAt: row.ledgerClosedAt,
      txHash:         row.txHash,
      eventId:        row.eventId,
    }));

    await upsertAccountSummaries(records);

    processed += batch.length;
    offset    += batch.length;

    const pct = ((processed / total) * 100).toFixed(1);
    console.log(`[backfill] ${processed}/${total} (${pct}%) — offset ${offset}`);
  }

  const summaryCount = await prisma.accountSummary.count();
  console.log(`[backfill] Done. ${summaryCount} account summary rows written.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[backfill] Fatal error:", err);
  process.exit(1);
});
