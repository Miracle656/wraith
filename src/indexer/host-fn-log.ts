/**
 * InvokeHostFn decoder and log store (#84).
 *
 * Every contract event flowing through the indexer is also recorded as a
 * raw host-function invocation so downstream consumers can interpret events
 * from arbitrary contracts — not just SAC token transfers.
 *
 * Storage layout:
 *   functionName  — topics[0] decoded as a symbol string
 *   args          — topics[1..n] serialised to JSON via scValToNative
 *   result        — value field serialised to JSON via scValToNative
 *   gasUsed       — nullable; populated externally if transaction metadata
 *                   is available (requires a separate getTransaction call)
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import type { RawEvent } from "../rpc";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HostFnRecord {
  contractId: string;
  functionName: string;
  args: unknown;
  result: unknown;
  gasUsed: bigint | null;
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  eventId: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert any value returned by scValToNative to something JSON.stringify can
 * handle.  BigInt values (i128/u128/i64/u64) are turned into decimal strings.
 */
function toJsonSafe(val: unknown): unknown {
  if (typeof val === "bigint") return val.toString();
  if (Array.isArray(val)) return val.map(toJsonSafe);
  if (val !== null && typeof val === "object") {
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, toJsonSafe(v)]),
    );
  }
  return val;
}

function scValToSafeJson(scVal: StellarSdk.xdr.ScVal): unknown {
  try {
    return toJsonSafe(StellarSdk.scValToNative(scVal));
  } catch {
    // Fall back to base64 XDR so no data is lost on unknown future ScVal types
    return { xdr: scVal.toXDR("base64") };
  }
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Convert any raw contract event into a HostFnRecord.
 * Returns null if the event cannot be decoded (e.g. empty topic list).
 */
export function parseHostFnEvent(raw: RawEvent): HostFnRecord | null {
  const { topic, value, contractId, ledger, ledgerClosedAt, txHash, id: eventId } = raw;

  if (!topic || topic.length === 0) return null;

  let functionName: string;
  try {
    const native = StellarSdk.scValToNative(topic[0]);
    if (typeof native !== "string") return null;
    functionName = native;
  } catch {
    return null;
  }

  const args   = topic.slice(1).map(scValToSafeJson);
  const result = scValToSafeJson(value);

  return {
    contractId,
    functionName,
    args,
    result,
    gasUsed: null,
    ledger,
    ledgerClosedAt: new Date(ledgerClosedAt),
    txHash,
    eventId,
  };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Idempotently persist a batch of host-fn log records.
 * Conflicts on `eventId` are silently ignored — safe to replay ledger ranges.
 */
export async function upsertHostFnLogs(records: HostFnRecord[]): Promise<number> {
  if (records.length === 0) return 0;

  const result = await prisma.hostFnLog.createMany({
    data: records.map(r => ({
      contractId:    r.contractId,
      functionName:  r.functionName,
      args:          r.args as Prisma.InputJsonValue,
      result:        r.result != null ? (r.result as Prisma.InputJsonValue) : Prisma.JsonNull,
      gasUsed:       r.gasUsed,
      ledger:        r.ledger,
      ledgerClosedAt: r.ledgerClosedAt,
      txHash:        r.txHash,
      eventId:       r.eventId,
    })),
    skipDuplicates: true,
  });

  return result.count;
}

export type HostFnQueryParams = {
  contractId: string;
  functionName?: string;
  limit?: number;
  offset?: number;
};

/**
 * Query host-function invocations for a given contract.
 * Results are ordered newest-ledger-first.
 */
export async function queryHostFnLogs(
  params: HostFnQueryParams,
): Promise<{ total: number; logs: HostFnRecord[] }> {
  const { contractId, functionName, limit = 50, offset = 0 } = params;
  const cap = Math.min(limit, 200);

  const where = {
    contractId,
    ...(functionName ? { functionName } : {}),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.hostFnLog.count({ where }),
    prisma.hostFnLog.findMany({
      where,
      orderBy: [{ ledger: "desc" }, { id: "desc" }],
      take: cap,
      skip: offset,
    }),
  ]);

  return {
    total,
    logs: rows.map(r => ({
      contractId:    r.contractId,
      functionName:  r.functionName,
      args:          r.args,
      result:        r.result,
      gasUsed:       r.gasUsed,
      ledger:        r.ledger,
      ledgerClosedAt: r.ledgerClosedAt,
      txHash:        r.txHash,
      eventId:       r.eventId,
    })),
  };
}
