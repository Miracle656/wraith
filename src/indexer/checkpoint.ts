import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import type { TransferRecord } from "../db";
import type { NftTransferRecord } from "../ingester/nft";
import type { HostFnRecord } from "./host-fn-log";

/**
 * Batch metadata for atomic processing.
 * All records in a batch are committed or rolled back as a unit,
 * with the cursor advancing only on successful commit.
 */
export interface BatchMetadata {
  batchId: string; // Unique identifier for this batch (e.g., "sac:6000-7000")
  fromLedger: number;
  toLedger: number; // Highest ledger in the batch
}

/**
 * Payload for an atomic batch write.
 */
export interface BatchPayload {
  transfers: TransferRecord[];
  nftTransfers: NftTransferRecord[];
  hostFnLogs: HostFnRecord[];
}

/**
 * Check if a batch has already been processed.
 * Useful for idempotent restart: if we crash mid-batch, resuming with the same
 * batchId allows us to skip re-processing.
 */
export async function hasCheckpoint(batchId: string): Promise<boolean> {
  const checkpoint = await prisma.indexerCheckpoint.findUnique({
    where: { batchId },
    select: { id: true },
  });
  return checkpoint !== null;
}

/**
 * Get the most recent checkpoint across all batches (for single-worker resume).
 * Returns the last ledger we successfully processed, or null if no checkpoints exist.
 */
export async function getLastCheckpoint(): Promise<number | null> {
  const checkpoint = await prisma.indexerCheckpoint.findFirst({
    orderBy: { lastLedger: "desc" },
    select: { lastLedger: true },
  });
  return checkpoint?.lastLedger ?? null;
}

/**
 * Atomically commit a batch of events and advance the checkpoint in a single
 * transaction. If the transaction fails or is interrupted, both the writes and
 * the checkpoint are rolled back — ensuring we never skip events or insert dupes.
 *
 * Strategy:
 *   1. Start a transaction
 *   2. Upsert all records (idempotent by eventId)
 *   3. Upsert the checkpoint atomically
 *   4. Commit or rollback as a unit
 *
 * If a batch is reprocessed (crash and restart with same batchId), the upserts
 * silently dedupe by eventId, and the checkpoint is updated to the same ledger.
 */
export async function commitBatch(
  metadata: BatchMetadata,
  payload: BatchPayload,
): Promise<{
  transferred: number;
  nftTransferred: number;
  hostFnLogs: number;
}> {
  const result = await prisma.$transaction(async (tx) => {
    // Upsert token transfers (idempotent by eventId)
    const transferred = payload.transfers.length
      ? (
          await tx.tokenTransfer.createMany({
            data: payload.transfers,
            skipDuplicates: true,
          })
        ).count
      : 0;

    // Upsert NFT transfers (idempotent by eventId)
    const nftTransferred = payload.nftTransfers.length
      ? (
          await tx.nftTransfer.createMany({
            data: payload.nftTransfers,
            skipDuplicates: true,
          })
        ).count
      : 0;

    // Upsert host function logs (idempotent by eventId)
    const hostFnLogs = payload.hostFnLogs.length
      ? (
          await tx.hostFnLog.createMany({
            data: payload.hostFnLogs.map((r) => ({
              contractId: r.contractId,
              functionName: r.functionName,
              args: r.args as Prisma.InputJsonValue,
              result:
                r.result != null
                  ? (r.result as Prisma.InputJsonValue)
                  : Prisma.JsonNull,
              gasUsed: r.gasUsed,
              ledger: r.ledger,
              ledgerClosedAt: r.ledgerClosedAt,
              txHash: r.txHash,
              eventId: r.eventId,
            })),
            skipDuplicates: true,
          })
        ).count
      : 0;

    // Atomically advance the checkpoint. On reprocessing the same batchId,
    // this upsert will update the timestamp but keep the same lastLedger.
    await tx.indexerCheckpoint.upsert({
      where: { batchId: metadata.batchId },
      create: {
        batchId: metadata.batchId,
        lastLedger: metadata.toLedger,
      },
      update: {
        lastLedger: metadata.toLedger,
        updatedAt: new Date(),
      },
    });

    return { transferred, nftTransferred, hostFnLogs };
  });

  return result;
}

/**
 * Update account summaries for the given transfer records.
 * This is called separately after the main batch commit because it's a derived
 * table that aggregates from transfers. If this fails, we don't lose data.
 */
export async function updateAccountSummaries(
  records: TransferRecord[],
): Promise<void> {
  if (records.length === 0) return;

  // Accumulate deltas keyed by "address|contractId"
  const deltas = new Map<
    string,
    {
      address: string;
      contractId: string;
      sent: bigint;
      received: bigint;
      count: number;
      lastAt: Date;
    }
  >();

  const touch = (
    address: string,
    contractId: string,
    sent: bigint,
    received: bigint,
    at: Date,
  ) => {
    const key = `${address}|${contractId}`;
    const prev = deltas.get(key) ?? {
      address,
      contractId,
      sent: 0n,
      received: 0n,
      count: 0,
      lastAt: at,
    };
    deltas.set(key, {
      address,
      contractId,
      sent: prev.sent + sent,
      received: prev.received + received,
      count: prev.count + 1,
      lastAt: at > prev.lastAt ? at : prev.lastAt,
    });
  };

  for (const {
    contractId,
    fromAddress,
    toAddress,
    amount,
    ledgerClosedAt,
  } of records) {
    const amt = BigInt(amount);
    if (fromAddress) touch(fromAddress, contractId, amt, 0n, ledgerClosedAt);
    if (toAddress) touch(toAddress, contractId, 0n, amt, ledgerClosedAt);
  }

  for (const {
    address,
    contractId,
    sent,
    received,
    count,
    lastAt,
  } of deltas.values()) {
    const sentStr = sent.toString();
    const receivedStr = received.toString();
    const netStr = (received - sent).toString();

    await prisma.$executeRaw`
      INSERT INTO wraith."AccountSummary"
        (address, "contractId", "totalSent", "totalReceived", net, "txCount", "lastActivityAt", "updatedAt")
      VALUES
        (${address}, ${contractId}, ${sentStr}, ${receivedStr}, ${netStr}, ${count}, ${lastAt}, NOW())
      ON CONFLICT (address, "contractId") DO UPDATE SET
        "totalSent"      = (wraith."AccountSummary"."totalSent"::NUMERIC     + ${sentStr}::NUMERIC)::TEXT,
        "totalReceived"  = (wraith."AccountSummary"."totalReceived"::NUMERIC  + ${receivedStr}::NUMERIC)::TEXT,
        net              = (wraith."AccountSummary"."totalReceived"::NUMERIC  + ${receivedStr}::NUMERIC
                           - wraith."AccountSummary"."totalSent"::NUMERIC     - ${sentStr}::NUMERIC)::TEXT,
        "txCount"        = wraith."AccountSummary"."txCount" + ${count},
        "lastActivityAt" = GREATEST(wraith."AccountSummary"."lastActivityAt", ${lastAt}),
        "updatedAt"      = NOW()
    `;
  }
}
