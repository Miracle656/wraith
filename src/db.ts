import { PrismaClient, Prisma } from "@prisma/client";

// ─── Singleton Prisma client ──────────────────────────────────────────────────
// Re-use one connection pool across the process.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// ─── Types ────────────────────────────────────────────────────────────────────
export interface TransferRecord {
  contractId: string;
  eventType: string; // "transfer" | "mint" | "burn" | "clawback"
  fromAddress: string | null;
  toAddress: string | null;
  amount: string; // i128 as decimal string
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  eventId: string;
}

// ─── Upsert helper ────────────────────────────────────────────────────────────
/**
 * Idempotently insert a batch of transfer events.
 * Conflicts on `eventId` are silently ignored — safe to call multiple times
 * with overlapping ledger ranges.
 */
export async function upsertTransfers(records: TransferRecord[]): Promise<number> {
  if (records.length === 0) return 0;

  // Prisma's createMany with skipDuplicates is the most efficient bulk path.
  const result = await prisma.tokenTransfer.createMany({
    data: records,
    skipDuplicates: true,
  });

  return result.count;
}

// ─── Indexer state helpers ────────────────────────────────────────────────────
/**
 * Read the last indexed ledger from DB.
 * Returns null if no state row exists yet.
 */
export async function getLastIndexedLedger(): Promise<number | null> {
  const state = await prisma.indexerState.findUnique({ where: { id: 1 } });
  return state?.lastIndexedLedger ?? null;
}

/**
 * Persist the last successfully indexed ledger sequence number.
 */
export async function setLastIndexedLedger(ledger: number): Promise<void> {
  await prisma.indexerState.upsert({
    where: { id: 1 },
    create: { id: 1, lastIndexedLedger: ledger },
    update: { lastIndexedLedger: ledger },
  });
}

// ─── Query helpers ────────────────────────────────────────────────────────────
export type TransferQueryParams = {
  address: string;
  direction: "incoming" | "outgoing";
  contractId?: string;
  fromLedger?: number;
  toLedger?: number;
  limit?: number;
  offset?: number;
};

export async function queryTransfers(params: TransferQueryParams) {
  const {
    address,
    direction,
    contractId,
    fromLedger,
    toLedger,
    limit = 50,
    offset = 0,
  } = params;

  const where: Prisma.TokenTransferWhereInput = {
    ...(direction === "incoming" ? { toAddress: address } : { fromAddress: address }),
    ...(contractId ? { contractId } : {}),
    ...(fromLedger || toLedger
      ? {
          ledger: {
            ...(fromLedger ? { gte: fromLedger } : {}),
            ...(toLedger ? { lte: toLedger } : {}),
          },
        }
      : {}),
  };

  const [total, transfers] = await prisma.$transaction([
    prisma.tokenTransfer.count({ where }),
    prisma.tokenTransfer.findMany({
      where,
      orderBy: [{ ledger: "desc" }, { id: "desc" }],
      take: Math.min(limit, 200), // hard cap — no one needs 10k rows per request
      skip: offset,
    }),
  ]);

  return { total, transfers };
}

export async function queryByTxHash(txHash: string) {
  return prisma.tokenTransfer.findMany({
    where: { txHash },
    orderBy: { id: "asc" },
  });
}
