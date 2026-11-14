/**
 * Periodic reconciliation for orders whose webhook never arrived.
 *
 * Linq's webhook is a push, and a push has no retry on our side. During a
 * crash loop an event is simply lost, leaving the order in whatever status it
 * was created with forever. Linq's status endpoints can answer the same
 * question, so this job asks them for a small, bounded page of old orders and
 * writes the answer through the same reconciliation functions the webhook
 * uses. That shared path is what keeps a paid order from being settled twice
 * or two halves of the service disagreeing about what happened.
 *
 * The provider's shared rate limit is the scarce resource here, not the
 * database, so both the page and the number of provider calls are capped.
 */

import type { NgnOrder, OfframpOrder, Prisma } from "@prisma/client";

import { prisma } from "../db";
import { getBillStatus } from "../linq/bills";
import { getOfframpStatus } from "../linq/client";
import { reconcileNgnOrder } from "../linq/ngnOrders";
import { reconcileOfframpOrder } from "../linq/offrampOrders";
import { getOnrampStatus } from "../linq/onramp";
import { when } from "../prismaWhen";

const DEFAULT_AGE_MS = 5 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MAX_PROVIDER_CALLS = 10;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INTERVAL_MS = 60 * 1000;

const TERMINAL_STATUS_VALUES = [
  "completed",
  "complete",
  "settled",
  "disbursed",
  "failed",
  "timeout",
  "expired",
  "refunded",
  "cancelled",
  "canceled",
  "reversed",
  "rejected",
  "success",
  "successful",
];

const TERMINAL_MARKERS = [
  "settled",
  "disbursed",
  "completed",
  "complete",
  "failed",
  "timeout",
  "expire",
  "refund",
  "cancel",
  "revers",
  "reject",
  "success",
];

/**
 * Segments that say the order is still moving, whatever else the status says.
 * Checked before the terminal markers so a compound status is read by its
 * tense rather than by whichever word appears in it.
 */
const NON_TERMINAL_SEGMENTS = [
  "pending",
  "processing",
  "awaiting",
  "queued",
  "initiated",
  "progress",
  "not",
];

/**
 * True when Linq will not change this order again.
 *
 * Matched segment by segment, not by substring. A plain `includes` reads
 * "incomplete" as "complete" and "refund_pending" as "refund", and because a
 * terminal status resets the attempt counter, such an order would be re-checked
 * on every sweep forever and never reach `needsHuman` — the unbounded polling
 * this job exists to prevent.
 */
export function isTerminalOrderStatus(status: string): boolean {
  const normalised = status.trim().toLowerCase();
  if (!normalised) return false;
  if (TERMINAL_STATUS_VALUES.includes(normalised)) return true;

  const segments = normalised.split(/[^a-z]+/).filter(Boolean);
  if (segments.some((segment) => NON_TERMINAL_SEGMENTS.includes(segment))) return false;

  return segments.some((segment) =>
    TERMINAL_MARKERS.some((marker) => segment === marker || segment.startsWith(marker)),
  );
}

export interface ReconcileOrdersOptions {
  /** Reference time; tests pass a fixed value. Defaults to `new Date()`. */
  now?: Date;
  /** Only consider orders created longer ago than this. */
  ageMs?: number;
  olderThanMs?: number;
  pageSize?: number;
  maxProviderCalls?: number;
  maxCalls?: number;
  /** After this many unresolved or failed checks the order is flagged. */
  maxAttempts?: number;
}

export interface ReconcileOrdersResult {
  scanned: number;
  checked: number;
  resolved: number;
  pending: number;
  unavailable: number;
  flagged: number;
}

type Candidate =
  | { kind: "offramp"; row: OfframpOrder }
  | { kind: "ngn"; row: NgnOrder };

type AttemptOutcome = "resolved" | "pending" | "unavailable" | "flagged";

function positiveEnvInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveOption(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

async function candidates(
  cutoff: Date,
  pageSize: number,
  maxAttempts: number,
): Promise<Candidate[]> {
  const where = {
    needsHuman: false,
    reconciliationAttempts: { lt: maxAttempts },
    status: { notIn: TERMINAL_STATUS_VALUES },
    createdAt: { lt: cutoff },
  };
  const orderBy = { createdAt: "asc" as const };

  const ngn = await prisma.ngnOrder.findMany({ where, orderBy, take: pageSize });

  // Guarded so a narrow test double that only implements the table under test
  // still exercises the rest of the job.
  const offrampModel = (prisma as unknown as {
    offrampOrder?: typeof prisma.offrampOrder;
  }).offrampOrder;
  const offramp = offrampModel
    ? await offrampModel.findMany({ where, orderBy, take: pageSize })
    : [];

  const rows: Candidate[] = [
    ...ngn.map((row) => ({ kind: "ngn" as const, row })),
    ...offramp.map((row) => ({ kind: "offramp" as const, row })),
  ];

  return rows
    .filter(({ row }) => !isTerminalOrderStatus(row.status))
    .sort((a, b) => a.row.createdAt.getTime() - b.row.createdAt.getTime())
    .slice(0, pageSize);
}

async function recordAttempt(
  candidate: Candidate,
  attempts: number,
  now: Date,
  needsHuman: boolean,
): Promise<void> {
  if (candidate.kind === "ngn") {
    await prisma.ngnOrder.update({
      where: {
        network_orderId: {
          network: candidate.row.network,
          orderId: candidate.row.orderId,
        },
      },
      data: {
        reconciliationAttempts: attempts,
        lastReconciledAt: now,
        ...when<Prisma.NgnOrderUpdateInput>(needsHuman, { needsHuman: true }),
      },
    });
    return;
  }

  await prisma.offrampOrder.update({
    where: {
      network_orderId: {
        network: candidate.row.network,
        orderId: candidate.row.orderId,
      },
    },
    data: {
      reconciliationAttempts: attempts,
      lastReconciledAt: now,
      ...when<Prisma.OfframpOrderUpdateInput>(needsHuman, { needsHuman: true }),
    },
  });
}

async function checkNgn(row: NgnOrder, now: Date, maxAttempts: number): Promise<AttemptOutcome> {
  const attempts = (row.reconciliationAttempts ?? 0) + 1;

  try {
    const live =
      row.kind === "bill"
        ? await getBillStatus(row.customerRef, row.orderId)
        : await getOnrampStatus(row.customerRef, row.orderId);

    const amounts =
      row.kind === "bill"
        ? {
            amountStableCoin: (live as { amountStableCoin?: number }).amountStableCoin,
            amountNGN: live.amountNgn,
          }
        : {
            amountStableCoin: (live as { amount?: number }).amount,
            amountNGN: live.amountNgn,
          };

    // The same call the webhook makes, so both paths apply one rule.
    await reconcileNgnOrder({
      orderId: row.orderId,
      network: row.network,
      status: live.status,
      event: live.status,
      ...(amounts.amountStableCoin != null ? { amountStableCoin: amounts.amountStableCoin } : {}),
      ...(amounts.amountNGN != null ? { amountNGN: amounts.amountNGN } : {}),
    });

    if (isTerminalOrderStatus(live.status)) {
      await recordAttempt({ kind: "ngn", row }, 0, now, false);
      return "resolved";
    }

    const giveUp = attempts >= maxAttempts;
    await recordAttempt({ kind: "ngn", row }, attempts, now, giveUp);
    return giveUp ? "flagged" : "pending";
  } catch (err) {
    const giveUp = attempts >= maxAttempts;
    await recordAttempt({ kind: "ngn", row }, attempts, now, giveUp);
    console.error(
      `[reconcile] could not read NGN order ${row.orderId} (attempt ${attempts}/${maxAttempts}):`,
      err,
    );
    return giveUp ? "flagged" : "unavailable";
  }
}

async function checkOfframp(
  row: OfframpOrder,
  now: Date,
  maxAttempts: number,
): Promise<AttemptOutcome> {
  const attempts = (row.reconciliationAttempts ?? 0) + 1;

  try {
    const live = await getOfframpStatus(row.orderId);

    await reconcileOfframpOrder({
      orderId: row.orderId,
      network: row.network,
      status: live.status,
      event: live.status,
      amountStableCoin: live.amountStableCoin,
      amountNGN: live.amountNGN,
    });

    if (isTerminalOrderStatus(live.status)) {
      await recordAttempt({ kind: "offramp", row }, 0, now, false);
      return "resolved";
    }

    const giveUp = attempts >= maxAttempts;
    await recordAttempt({ kind: "offramp", row }, attempts, now, giveUp);
    return giveUp ? "flagged" : "pending";
  } catch (err) {
    const giveUp = attempts >= maxAttempts;
    await recordAttempt({ kind: "offramp", row }, attempts, now, giveUp);
    console.error(
      `[reconcile] could not read offramp order ${row.orderId} (attempt ${attempts}/${maxAttempts}):`,
      err,
    );
    return giveUp ? "flagged" : "unavailable";
  }
}

/**
 * One bounded sweep. Safe to run repeatedly: terminal orders are not selected,
 * and the write itself is the webhook's idempotent update.
 */
export async function runOrderReconciliationJob(
  options: ReconcileOrdersOptions = {},
): Promise<ReconcileOrdersResult> {
  const now = options.now ?? new Date();
  const ageMs = positiveOption(
    options.ageMs ?? options.olderThanMs,
    positiveEnvInt("ORDER_RECONCILIATION_AGE_MS", DEFAULT_AGE_MS),
  );
  const pageSize = positiveOption(
    options.pageSize,
    positiveEnvInt("ORDER_RECONCILIATION_PAGE_SIZE", DEFAULT_PAGE_SIZE),
  );
  const maxProviderCalls = positiveOption(
    options.maxProviderCalls ?? options.maxCalls,
    positiveEnvInt("ORDER_RECONCILIATION_MAX_PROVIDER_CALLS", DEFAULT_MAX_PROVIDER_CALLS),
  );
  const maxAttempts = positiveOption(
    options.maxAttempts,
    positiveEnvInt("ORDER_RECONCILIATION_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS),
  );

  const cutoff = new Date(now.getTime() - ageMs);
  const pending = await candidates(cutoff, pageSize, maxAttempts);

  const result: ReconcileOrdersResult = {
    scanned: pending.length,
    checked: 0,
    resolved: 0,
    pending: 0,
    unavailable: 0,
    flagged: 0,
  };

  for (const candidate of pending) {
    if (result.checked >= maxProviderCalls) break;

    result.checked += 1;
    const outcome =
      candidate.kind === "ngn"
        ? await checkNgn(candidate.row, now, maxAttempts)
        : await checkOfframp(candidate.row, now, maxAttempts);

    result[outcome] += 1;
  }

  if (result.checked > 0) {
    console.log(
      `[reconcile] scanned=${result.scanned} checked=${result.checked} ` +
        `resolved=${result.resolved} pending=${result.pending} ` +
        `unavailable=${result.unavailable} flagged=${result.flagged}`,
    );
  }

  return result;
}

export function startOrderReconciliationJob(): NodeJS.Timeout | null {
  const intervalMs = parseInt(
    process.env.ORDER_RECONCILIATION_INTERVAL_MS ?? `${DEFAULT_INTERVAL_MS}`,
    10,
  );
  if (Number.isNaN(intervalMs) || intervalMs <= 0) {
    return null;
  }

  // A sweep is slowest exactly when the provider is struggling, which is when
  // the interval is most likely to fire again before it finishes. Two
  // overlapping sweeps select the same candidates, because neither has recorded
  // an attempt yet, so the per-sweep provider-call cap stops bounding anything.
  let running = false;
  const run = () => {
    if (running) {
      console.warn("[reconcile] previous sweep still running, skipping this tick");
      return;
    }
    running = true;
    void runOrderReconciliationJob()
      .catch((error) => {
        console.error("[reconcile] Job failed:", error);
      })
      .finally(() => {
        running = false;
      });
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
