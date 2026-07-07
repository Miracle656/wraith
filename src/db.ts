import { PrismaClient, Prisma } from "@prisma/client";
import type { NftTransferRecord, NftMetadataPayload } from "./ingester/nft";
import { decodeCursor, encodeCursor, parseODataFilter, parseODataSelect, projectRecord } from "./lib/odata";

const STROOPS = 10_000_000n;

export function toDisplayAmount(amount: string): string {
  const raw = BigInt(amount);
  const abs = raw < 0n ? -raw : raw;
  const integer = abs / STROOPS;
  const remainder = abs % STROOPS;
  const sign = raw < 0n ? "-" : "";
  return `${sign}${integer}.${String(remainder).padStart(7, "0")}`;
}

import { withReadReplicas } from "./db/router";

// ─── Singleton Prisma client ──────────────────────────────────────────────────
// Re-use one connection pool across the process.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const replicaUrls = process.env.DATABASE_REPLICAS
  ? process.env.DATABASE_REPLICAS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

export const prisma =
  globalForPrisma.prisma ??
  withReadReplicas(
    new PrismaClient({
      log:
        process.env.NODE_ENV === "development"
          ? ["query", "warn", "error"]
          : ["warn", "error"],
    }),
    { replicaUrls }
  );

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
  isSac?: boolean; // true when the contract is a Stellar Asset Contract (#136)
}

type ListPage<T> = {
  rows: T[];
  nextCursor: string | null;
};

function buildListPage<T extends { id: number }>(rows: T[], limit: number): ListPage<T> {
  if (rows.length <= limit) {
    return { rows, nextCursor: null };
  }

  const pageRows = rows.slice(0, limit);
  return {
    rows: pageRows,
    nextCursor: encodeCursor(pageRows[pageRows.length - 1].id),
  };
}

function selectRows<T extends Record<string, unknown>>(
  rows: T[],
  select: string[] | undefined,
  derived: Record<string, (row: T) => unknown> = {}
): Array<Record<string, unknown>> {
  return rows.map((row) => projectRecord(row, select, derived));
}

const TRANSFER_SELECTABLE_FIELDS = [
  "id",
  "contractId",
  "eventType",
  "fromAddress",
  "toAddress",
  "amount",
  "ledger",
  "ledgerClosedAt",
  "txHash",
  "eventId",
  "isSac",
  "createdAt",
  "displayAmount",
  "direction",
];

const NFT_TRANSFER_SELECTABLE_FIELDS = [
  "id",
  "contractId",
  "tokenId",
  "fromAddress",
  "toAddress",
  "ledger",
  "ledgerClosedAt",
  "txHash",
  "eventId",
  "createdAt",
];

const ACCOUNT_SUMMARY_SELECTABLE_FIELDS = [
  "id",
  "address",
  "contractId",
  "totalSent",
  "totalReceived",
  "net",
  "txCount",
  "lastActivityAt",
  "updatedAt",
  "displayTotalSent",
  "displayTotalReceived",
  "displayNet",
];

const TRANSFER_FIELD_TYPES = {
  id: { type: "number" as const },
  contractId: { type: "string" as const },
  eventType: { type: "string" as const },
  fromAddress: { type: "string" as const },
  toAddress: { type: "string" as const },
  amount: { type: "string" as const },
  ledger: { type: "number" as const },
  ledgerClosedAt: { type: "date" as const },
  txHash: { type: "string" as const },
  eventId: { type: "string" as const },
  createdAt: { type: "date" as const },
};

const NFT_TRANSFER_FIELD_TYPES = {
  id: { type: "number" as const },
  contractId: { type: "string" as const },
  tokenId: { type: "string" as const },
  fromAddress: { type: "string" as const },
  toAddress: { type: "string" as const },
  ledger: { type: "number" as const },
  ledgerClosedAt: { type: "date" as const },
  txHash: { type: "string" as const },
  eventId: { type: "string" as const },
  createdAt: { type: "date" as const },
};

const ACCOUNT_SUMMARY_FIELD_TYPES = {
  id: { type: "number" as const },
  address: { type: "string" as const },
  contractId: { type: "string" as const },
  totalSent: { type: "string" as const },
  totalReceived: { type: "string" as const },
  net: { type: "string" as const },
  txCount: { type: "number" as const },
  lastActivityAt: { type: "date" as const },
  updatedAt: { type: "date" as const },
};

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

// ─── Backfill cursor helpers ──────────────────────────────────────────────────
export interface BackfillCursorState {
  startLedger: number;
  endLedger: number;
  nextLedger: number;
}

export async function getBackfillCursor(): Promise<BackfillCursorState | null> {
  const state = await prisma.backfillCursor.findUnique({ where: { id: 1 } });
  return state
    ? { startLedger: state.startLedger, endLedger: state.endLedger, nextLedger: state.nextLedger }
    : null;
}

export async function setBackfillCursor(cursor: BackfillCursorState): Promise<void> {
  await prisma.backfillCursor.upsert({
    where: { id: 1 },
    create: { id: 1, ...cursor },
    update: cursor,
  });
}

export async function clearBackfillCursor(): Promise<void> {
  await prisma.backfillCursor.deleteMany({ where: { id: 1 } });
}

// ─── Data retention ──────────────────────────────────────────────────────────
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS ?? "30", 10);

/**
 * Delete transfers older than RETENTION_DAYS to keep the DB within free-tier limits.
 * Returns the number of rows deleted.
 */
export async function pruneOldTransfers(): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  const result = await prisma.tokenTransfer.deleteMany({
    where: { ledgerClosedAt: { lt: cutoff } },
  });

  if (result.count > 0) {
    console.log(
      `[prune] Deleted ${result.count} transfers older than ${RETENTION_DAYS} days (before ${cutoff.toISOString()})`
    );
  }

  return result.count;
}

// ─── Query helpers ────────────────────────────────────────────────────────────
export type TransferQueryParams = {
  address: string;
  direction: "incoming" | "outgoing";
  contractId?: string;
  token?: string;
  filter?: string;
  select?: string[];
  cursor?: string;
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
    token,
    filter,
    select,
    cursor,
    fromLedger,
    toLedger,
    fromDate,
    toDate,
    eventTypes,
    limit = 50,
    offset = 0,
  } = params;

  const baseWhere: Prisma.TokenTransferWhereInput = {
    ...(direction === "incoming" ? { toAddress: address } : { fromAddress: address }),
    ...(contractId ? { contractId } : {}),
    ...(token ? { contractId: token } : {}),
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

  const odataWhere = parseODataFilter(filter, TRANSFER_FIELD_TYPES);
  const where: Prisma.TokenTransferWhereInput = odataWhere
    ? { AND: [baseWhere, odataWhere as Prisma.TokenTransferWhereInput] }
    : baseWhere;

  const requestedSelect = parseODataSelect(select?.join(","), TRANSFER_SELECTABLE_FIELDS);
  const prismaSelect = requestedSelect
    ? {
        id: true,
        contractId: requestedSelect.includes("contractId"),
        eventType: requestedSelect.includes("eventType"),
        fromAddress: requestedSelect.includes("fromAddress"),
        toAddress: requestedSelect.includes("toAddress"),
        amount: requestedSelect.includes("amount") || requestedSelect.includes("displayAmount"),
        ledger: requestedSelect.includes("ledger"),
        ledgerClosedAt: requestedSelect.includes("ledgerClosedAt"),
        txHash: requestedSelect.includes("txHash"),
        eventId: requestedSelect.includes("eventId"),
        isSac: requestedSelect.includes("isSac"),
        createdAt: requestedSelect.includes("createdAt"),
      }
    : undefined;

  const cap = Math.min(limit, 200);
  const cursorId = decodeCursor(cursor);

  const [total, transfers] = await prisma.$transaction([
    prisma.tokenTransfer.count({ where }),
    prisma.tokenTransfer.findMany({
      where,
      orderBy: [{ ledger: "desc" }, { id: "desc" }],
      take: cap + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : { skip: offset }),
      ...(prismaSelect ? { select: prismaSelect } : {}),
    }),
  ]);

  const page = buildListPage(transfers as Array<{ id: number }>, cap);

  return {
    total,
    transfers: selectRows(page.rows as Array<Record<string, unknown>>, requestedSelect, {
      displayAmount: (row) => toDisplayAmount(String((row as { amount?: string }).amount)),
    }),
    nextCursor: page.nextCursor,
  };
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
    FROM "wraith"."TokenTransfer"
    WHERE ${where}
    GROUP BY "contractId"
    ORDER BY "contractId"
  `;
}

// ─── NFT helpers ─────────────────────────────────────────────────────────────

export async function upsertNftTransfers(records: NftTransferRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  const result = await prisma.nftTransfer.createMany({
    data: records,
    skipDuplicates: true,
  });
  return result.count;
}

export async function getNftMetadata(
  contractId: string,
  tokenId: string
): Promise<{ name: string | null; tokenUri: string | null } | null> {
  return prisma.nftMetadata.findUnique({
    where: { contractId_tokenId: { contractId, tokenId } },
    select: { name: true, tokenUri: true },
  });
}

/**
 * Roll back indexed rows to a target ledger sequence.
 * Deletes any rows with ledger > `targetLedger` from event tables
 * and atomically updates the indexer state to reflect the new tip.
 * Returns the number of deleted rows (sum across tables).
 */
export async function rollbackToLedger(targetLedger: number): Promise<number> {
  // Perform deletes and state update atomically.
  const [deletedTransfers, deletedNftTransfers, deletedHostFnLogs, _state] = await prisma.$transaction([
    prisma.tokenTransfer.deleteMany({ where: { ledger: { gt: targetLedger } } }),
    prisma.nftTransfer.deleteMany({ where: { ledger: { gt: targetLedger } } }),
    prisma.hostFnLog.deleteMany({ where: { ledger: { gt: targetLedger } } }),
    prisma.indexerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastIndexedLedger: targetLedger },
      update: { lastIndexedLedger: targetLedger },
    }),
  ]);

  const totalDeleted =
    (deletedTransfers?.count ?? 0) + (deletedNftTransfers?.count ?? 0) + (deletedHostFnLogs?.count ?? 0);

  if (totalDeleted > 0) {
    console.log(`[reorg] Rolled back to ledger ${targetLedger}, deleted ${totalDeleted} rows`);
  } else {
    console.log(`[reorg] Rolled back to ledger ${targetLedger}, no rows deleted`);
  }

  return totalDeleted;
}

export async function upsertNftMetadata(
  contractId: string,
  tokenId: string,
  data: NftMetadataPayload
): Promise<void> {
  await prisma.nftMetadata.upsert({
    where: { contractId_tokenId: { contractId, tokenId } },
    create: { contractId, tokenId, name: data.name ?? null, tokenUri: data.tokenUri ?? null },
    update: { name: data.name ?? null, tokenUri: data.tokenUri ?? null, fetchedAt: new Date() },
  });
}

export type NftTransferQueryParams = {
  contractId?: string;
  tokenId?: string;
  address?: string;
  filter?: string;
  select?: string[];
  cursor?: string;
  fromLedger?: number;
  toLedger?: number;
  limit?: number;
  offset?: number;
};

export async function queryNftTransfers(params: NftTransferQueryParams) {
  const {
    contractId,
    tokenId,
    address,
    filter,
    select,
    cursor,
    fromLedger,
    toLedger,
    limit = 50,
    offset = 0,
  } = params;

  const baseWhere: Prisma.NftTransferWhereInput = {
    ...(contractId ? { contractId } : {}),
    ...(tokenId ? { tokenId } : {}),
    ...(address ? { OR: [{ fromAddress: address }, { toAddress: address }] } : {}),
    ...(fromLedger || toLedger
      ? {
          ledger: {
            ...(fromLedger ? { gte: fromLedger } : {}),
            ...(toLedger ? { lte: toLedger } : {}),
          },
        }
      : {}),
  };

  const odataWhere = parseODataFilter(filter, NFT_TRANSFER_FIELD_TYPES);
  const where: Prisma.NftTransferWhereInput = odataWhere
    ? { AND: [baseWhere, odataWhere as Prisma.NftTransferWhereInput] }
    : baseWhere;

  const requestedSelect = parseODataSelect(select?.join(","), NFT_TRANSFER_SELECTABLE_FIELDS);
  const prismaSelect = requestedSelect
    ? {
        id: true,
        contractId: requestedSelect.includes("contractId"),
        tokenId: requestedSelect.includes("tokenId"),
        fromAddress: requestedSelect.includes("fromAddress"),
        toAddress: requestedSelect.includes("toAddress"),
        ledger: requestedSelect.includes("ledger"),
        ledgerClosedAt: requestedSelect.includes("ledgerClosedAt"),
        txHash: requestedSelect.includes("txHash"),
        eventId: requestedSelect.includes("eventId"),
        createdAt: requestedSelect.includes("createdAt"),
      }
    : undefined;

  const cap = Math.min(limit, 200);
  const cursorId = decodeCursor(cursor);
  const [total, transfers] = await prisma.$transaction([
    prisma.nftTransfer.count({ where }),
    prisma.nftTransfer.findMany({
      where,
      orderBy: [{ ledger: "desc" }, { id: "desc" }],
      take: cap + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : { skip: offset }),
      ...(prismaSelect ? { select: prismaSelect } : {}),
    }),
  ]);

  const page = buildListPage(transfers as Array<{ id: number }>, cap);

  return {
    total,
    transfers: selectRows(page.rows as Array<Record<string, unknown>>, requestedSelect),
    nextCursor: page.nextCursor,
  };
}

/**
 * Return the current owner of a token: the toAddress of its most recent transfer.
 */
export async function getNftOwner(
  contractId: string,
  tokenId: string
): Promise<string | null> {
  const latest = await prisma.nftTransfer.findFirst({
    where: { contractId, tokenId, toAddress: { not: null } },
    orderBy: [{ ledger: "desc" }, { id: "desc" }],
    select: { toAddress: true },
  });
  return latest?.toAddress ?? null;
}

// ─── Account summary helpers ──────────────────────────────────────────────────

/**
 * Incrementally update materialized aggregates for every address touched by
 * `records`. Called inside the same logical write as upsertTransfers so the
 * two tables never diverge.
 *
 * Strategy:
 *   1. Accumulate per-(address, contractId) deltas in memory.
 *   2. Emit one raw UPSERT per unique pair — O(unique addresses) DB round-trips.
 *
 * Using raw SQL because Prisma cannot do arithmetic on string-typed NUMERIC columns.
 */
export async function upsertAccountSummaries(records: TransferRecord[]): Promise<void> {
  if (records.length === 0) return;

  // Accumulate deltas keyed by "address|contractId"
  const deltas = new Map<
    string,
    { address: string; contractId: string; sent: bigint; received: bigint; count: number; lastAt: Date }
  >();

  const touch = (address: string, contractId: string, sent: bigint, received: bigint, at: Date) => {
    const key = `${address}|${contractId}`;
    const prev = deltas.get(key) ?? { address, contractId, sent: 0n, received: 0n, count: 0, lastAt: at };
    deltas.set(key, {
      address,
      contractId,
      sent: prev.sent + sent,
      received: prev.received + received,
      count: prev.count + 1,
      lastAt: at > prev.lastAt ? at : prev.lastAt,
    });
  };

  for (const { contractId, fromAddress, toAddress, amount, ledgerClosedAt } of records) {
    const amt = BigInt(amount);
    if (fromAddress) touch(fromAddress, contractId, amt, 0n, ledgerClosedAt);
    if (toAddress)   touch(toAddress,   contractId, 0n, amt, ledgerClosedAt);
  }

  for (const { address, contractId, sent, received, count, lastAt } of deltas.values()) {
    const sentStr     = sent.toString();
    const receivedStr = received.toString();
    const netStr      = (received - sent).toString();

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

/**
 * Return all asset rows for a given address, optionally filtered to one contract.
 * O(1) — reads directly from the materialized AccountSummary table.
 */
export async function getAccountSummary(address: string, contractId?: string) {
  return prisma.accountSummary.findMany({
    where: {
      address,
      ...(contractId ? { contractId } : {}),
    },
    orderBy: { lastActivityAt: "desc" },
    select: {
      contractId:     true,
      totalSent:      true,
      totalReceived:  true,
      net:            true,
      txCount:        true,
      lastActivityAt: true,
    },
  });
}

export type AccountSummaryQueryParams = {
  address: string;
  contractId?: string;
  filter?: string;
  select?: string[];
  cursor?: string;
  limit?: number;
  offset?: number;
};

export async function queryAccountSummaries(params: AccountSummaryQueryParams) {
  const { address, contractId, filter, select, cursor, limit = 50, offset = 0 } = params;

  const baseWhere: Prisma.AccountSummaryWhereInput = {
    address,
    ...(contractId ? { contractId } : {}),
  };

  const odataWhere = parseODataFilter(filter, ACCOUNT_SUMMARY_FIELD_TYPES);
  const where: Prisma.AccountSummaryWhereInput = odataWhere
    ? { AND: [baseWhere, odataWhere as Prisma.AccountSummaryWhereInput] }
    : baseWhere;

  const requestedSelect = parseODataSelect(select?.join(","), ACCOUNT_SUMMARY_SELECTABLE_FIELDS);
  const prismaSelect = requestedSelect
    ? {
        id: true,
        address: requestedSelect.includes("address"),
        contractId: requestedSelect.includes("contractId"),
        totalSent: requestedSelect.includes("totalSent"),
        totalReceived: requestedSelect.includes("totalReceived"),
        net: requestedSelect.includes("net"),
        txCount: requestedSelect.includes("txCount"),
        lastActivityAt: requestedSelect.includes("lastActivityAt"),
        updatedAt: requestedSelect.includes("updatedAt"),
      }
    : undefined;

  const cap = Math.min(limit, 200);
  const cursorId = decodeCursor(cursor);
  const [total, rows] = await prisma.$transaction([
    prisma.accountSummary.count({ where }),
    prisma.accountSummary.findMany({
      where,
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
      take: cap + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : { skip: offset }),
      ...(prismaSelect ? { select: prismaSelect } : {}),
    }),
  ]);

  const page = buildListPage(rows as Array<{ id: number }>, cap);

  return {
    total,
    transfers: selectRows(page.rows as Array<Record<string, unknown>>, requestedSelect, {
      displayTotalSent: (row) => row.totalSent,
      displayTotalReceived: (row) => row.totalReceived,
      displayNet: (row) => row.net,
    }),
    nextCursor: page.nextCursor,
  };
}

// ─── Combined address query ───────────────────────────────────────────────────
export type AllTransfersQueryParams = {
  address: string;
  contractId?: string;
  token?: string;
  filter?: string;
  select?: string[];
  cursor?: string;
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
    token,
    filter,
    select,
    cursor,
    fromLedger,
    toLedger,
    fromDate,
    toDate,
    eventTypes,
    limit = 50,
    offset = 0,
  } = params;

  const baseWhere: Prisma.TokenTransferWhereInput = {
    OR: [{ toAddress: address }, { fromAddress: address }],
    ...(contractId ? { contractId } : {}),
    ...(token ? { contractId: token } : {}),
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

  const odataWhere = parseODataFilter(filter, TRANSFER_FIELD_TYPES);
  const where: Prisma.TokenTransferWhereInput = odataWhere
    ? { AND: [baseWhere, odataWhere as Prisma.TokenTransferWhereInput] }
    : baseWhere;

  const cap = Math.min(limit, 200);
  const cursorId = decodeCursor(cursor);
  const requestedSelect = parseODataSelect(select?.join(","), TRANSFER_SELECTABLE_FIELDS);
  const prismaSelect = requestedSelect
    ? {
        id: true,
        contractId: requestedSelect.includes("contractId"),
        eventType: requestedSelect.includes("eventType"),
        fromAddress: requestedSelect.includes("fromAddress"),
        toAddress: requestedSelect.includes("toAddress"),
        amount: requestedSelect.includes("amount") || requestedSelect.includes("displayAmount"),
        ledger: requestedSelect.includes("ledger"),
        ledgerClosedAt: requestedSelect.includes("ledgerClosedAt"),
        txHash: requestedSelect.includes("txHash"),
        eventId: requestedSelect.includes("eventId"),
        isSac: requestedSelect.includes("isSac"),
        createdAt: requestedSelect.includes("createdAt"),
      }
    : undefined;

  const [total, rows] = await prisma.$transaction([
    prisma.tokenTransfer.count({ where }),
    prisma.tokenTransfer.findMany({
      where,
      orderBy: [{ ledger: "desc" }, { id: "desc" }],
      take: cap + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : { skip: offset }),
      ...(prismaSelect ? { select: prismaSelect } : {}),
    }),
  ]);

  const page = buildListPage(rows as Array<{ id: number }>, cap);

  const transfers = selectRows(page.rows as Array<Record<string, unknown>>, requestedSelect ? [...requestedSelect, "direction"] : undefined, {
    displayAmount: (row) => toDisplayAmount(String((row as { amount?: string }).amount)),
    direction: (row) => ((row as { toAddress?: string | null }).toAddress === address ? "incoming" : "outgoing"),
  });

  return { total, transfers, nextCursor: page.nextCursor };
}

// ─── Popular assets query ───────────────────────────────────────────────────
export type PopularAssetsQueryParams = {
  fromDate: Date;
  by: string;
  limit: number;
  offset: number;
};

type PopularAssetRow = {
  contractId: string;
  transferCount: bigint;
  volume: string;
};

export async function queryPopularAssets(params: PopularAssetsQueryParams) {
  const { fromDate, by, limit, offset } = params;
  const cap = Math.min(limit, 100);

  const orderClause = by === "volume"
    ? Prisma.sql`SUM(CAST("amount" AS NUMERIC)) DESC`
    : Prisma.sql`COUNT(*) DESC`;

  const countResult = await prisma.$queryRaw<Array<{ total: bigint }>>`
    SELECT COUNT(DISTINCT "contractId")::INT8 AS "total"
    FROM "wraith"."TokenTransfer"
    WHERE "ledgerClosedAt" >= ${fromDate}
  `;
  const total = Number(countResult[0]?.total ?? 0);

  const assets = await prisma.$queryRaw<PopularAssetRow[]>`
    SELECT
      "contractId",
      COUNT(*)::INT8 AS "transferCount",
      COALESCE(SUM(CAST("amount" AS NUMERIC)), 0)::TEXT AS "volume"
    FROM "wraith"."TokenTransfer"
    WHERE "ledgerClosedAt" >= ${fromDate}
    GROUP BY "contractId"
    ORDER BY ${orderClause}
    LIMIT ${cap}
    OFFSET ${offset}
  `;

  return { total, assets };
}
