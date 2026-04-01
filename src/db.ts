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
  fromDate?: Date;
  toDate?: Date;
  eventTypes?: string[];
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
    fromDate,
    toDate,
    eventTypes,
    limit = 50,
    offset = 0,
  } = params;

  const where: Prisma.TokenTransferWhereInput = {
    ...(direction === "incoming" ? { toAddress: address } : { fromAddress: address }),
    ...(contractId ? { contractId } : {}),
    ...(eventTypes?.length ? { eventType: { in: eventTypes } } : {}),
    ...(fromLedger || toLedger
      ? {
          ledger: {
            ...(fromLedger ? { gte: fromLedger } : {}),
            ...(toLedger ? { lte: toLedger } : {}),
          },
        }
      : {}),
    ...(fromDate || toDate
      ? {
          ledgerClosedAt: {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
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

// ─── Summary aggregate query ──────────────────────────────────────────────────
export type SummaryQueryParams = {
  address: string;
  contractId?: string;
  fromDate?: Date;
  toDate?: Date;
};

type SummaryRow = {
  contractId: string;
  totalReceived: string; // NUMERIC cast to TEXT
  totalSent: string;     // NUMERIC cast to TEXT
  txCount: bigint;       // INT8 — node-postgres returns bigint columns as BigInt
};

/**
 * Returns per-token aggregate totals for an address.
 * Uses a raw SQL query because Prisma cannot SUM string-typed columns.
 */
export async function querySummary(params: SummaryQueryParams): Promise<SummaryRow[]> {
  const { address, contractId, fromDate, toDate } = params;

  const conditions: Prisma.Sql[] = [
    Prisma.sql`("toAddress" = ${address} OR "fromAddress" = ${address})`,
  ];
  if (contractId) conditions.push(Prisma.sql`"contractId" = ${contractId}`);
  if (fromDate)   conditions.push(Prisma.sql`"ledgerClosedAt" >= ${fromDate}`);
  if (toDate)     conditions.push(Prisma.sql`"ledgerClosedAt" <= ${toDate}`);

  const where = Prisma.join(conditions, " AND ");

  return prisma.$queryRaw<SummaryRow[]>`
    SELECT
      "contractId",
      COALESCE(SUM(CASE WHEN "toAddress"   = ${address} THEN CAST("amount" AS NUMERIC) ELSE 0 END), 0)::TEXT AS "totalReceived",
      COALESCE(SUM(CASE WHEN "fromAddress" = ${address} THEN CAST("amount" AS NUMERIC) ELSE 0 END), 0)::TEXT AS "totalSent",
      COUNT(*)::INT8 AS "txCount"
    FROM "TokenTransfer"
    WHERE ${where}
    GROUP BY "contractId"
    ORDER BY "contractId"
  `;
}

// ─── Combined address query ───────────────────────────────────────────────────
export type AllTransfersQueryParams = {
  address: string;
  contractId?: string;
  fromLedger?: number;
  toLedger?: number;
  fromDate?: Date;
  toDate?: Date;
  eventTypes?: string[];
  limit?: number;
  offset?: number;
};

export async function queryAllTransfers(params: AllTransfersQueryParams) {
  const {
    address,
    contractId,
    fromLedger,
    toLedger,
    fromDate,
    toDate,
    eventTypes,
    limit = 50,
    offset = 0,
  } = params;

  const where: Prisma.TokenTransferWhereInput = {
    OR: [{ toAddress: address }, { fromAddress: address }],
    ...(contractId ? { contractId } : {}),
    ...(eventTypes?.length ? { eventType: { in: eventTypes } } : {}),
    ...(fromLedger || toLedger
      ? {
          ledger: {
            ...(fromLedger ? { gte: fromLedger } : {}),
            ...(toLedger ? { lte: toLedger } : {}),
          },
        }
      : {}),
    ...(fromDate || toDate
      ? {
          ledgerClosedAt: {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          },
        }
      : {}),
  };

  const cap = Math.min(limit, 200);

  const [total, rows] = await prisma.$transaction([
    prisma.tokenTransfer.count({ where }),
    prisma.tokenTransfer.findMany({
      where,
      orderBy: [{ ledger: "desc" }, { id: "desc" }],
      take: cap,
      skip: offset,
    }),
  ]);

  const transfers = rows.map((r: { toAddress: string | null; amount: string; [key: string]: unknown }) => ({
    ...r,
    direction: r.toAddress === address ? "incoming" : "outgoing",
  }));

  return { total, transfers };
}
