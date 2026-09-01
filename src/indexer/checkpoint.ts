import { Prisma } from "@prisma/client";
import { prisma, upsertAccountSummaries } from "../db";
import type { TransferRecord } from "../db";
import type { NftTransferRecord } from "../ingester/nft";
import type { HostFnRecord } from "./host-fn-log";
import { resolveNetwork, type Network } from "../network";

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
export async function hasCheckpoint(batchId: string, network?: Network): Promise<boolean> {
  const checkpoint = await prisma.indexerCheckpoint.findUnique({
    where: { network_batchId: { network: resolveNetwork(network), batchId } },
    select: { id: true },
  });
  return checkpoint !== null;
}

/**
 * Get the most recent checkpoint across all batches on one network (for
 * single-worker resume). Returns the last ledger we successfully processed, or
 * null if no checkpoints exist.
 *
 * Scoping is not optional here: ledger sequences are per-chain, so an unscoped
 * "highest lastLedger" would hand a mainnet worker testnet's far-ahead tip and
 * skip every mainnet ledger in between.
 */
export async function getLastCheckpoint(network?: Network): Promise<number | null> {
  const checkpoint = await prisma.indexerCheckpoint.findFirst({
    where: { network: resolveNetwork(network) },
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
  network?: Network,
): Promise<{
  transferred: number;
  nftTransferred: number;
  hostFnLogs: number;
}> {
  // Stamped explicitly on every row. The column has a DEFAULT of 'testnet', so
  // omitting it compiles and silently files mainnet events under testnet —
  // the one failure mode in #159 that no type error would catch.
  const net = resolveNetwork(network);

  const result = await prisma.$transaction(async (tx) => {
    // Upsert token transfers (idempotent by (network, eventId))
    const transferred = payload.transfers.length
      ? (
          await tx.tokenTransfer.createMany({
            data: payload.transfers.map((r) => ({ ...r, network: net })),
            skipDuplicates: true,
          })
        ).count
      : 0;

    // Upsert NFT transfers (idempotent by (network, eventId))
    const nftTransferred = payload.nftTransfers.length
      ? (
          await tx.nftTransfer.createMany({
            data: payload.nftTransfers.map((r) => ({ ...r, network: net })),
            skipDuplicates: true,
          })
        ).count
      : 0;

    // Upsert host function logs (idempotent by (network, eventId))
    const hostFnLogs = payload.hostFnLogs.length
      ? (
          await tx.hostFnLog.createMany({
            data: payload.hostFnLogs.map((r) => ({
              network: net,
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
      where: { network_batchId: { network: net, batchId: metadata.batchId } },
      create: {
        network: net,
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
 * This is called separately after the main batch commit because it is a
 * derived table that aggregates from transfers. If this fails, we do not lose
 * data.
 *
 * Delegates to `upsertAccountSummaries` in db.ts rather than keeping a second
 * copy of the raw upsert. The two had drifted into byte-identical duplicates,
 * and #159 made that actively dangerous: the statement carries an
 * `ON CONFLICT (network, address, contractId)` target that has to match the
 * unique index exactly, so a copy left behind would throw
 * "no unique or exclusion constraint matching the ON CONFLICT specification"
 * on every write.
 */
export async function updateAccountSummaries(
  records: TransferRecord[],
  network?: Network,
): Promise<void> {
  await upsertAccountSummaries(records, resolveNetwork(network));
}
