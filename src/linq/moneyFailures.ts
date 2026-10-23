/**
 * Durable records of money-affecting failures.
 *
 * When an offramp order ends failed, the user sees an error and — until this
 * existed — nothing else happened: no record, no count, no way to answer
 * "what broke today" without a log search. A payout that fails after the
 * user's crypto has been taken is the worst state this system can reach, and
 * it must not have to be reported by the user.
 *
 * This module is the only writer of the `MoneyFailure` table. It draws the
 * line the issue draws:
 *
 *   - Money-affecting failures are recorded: an order that ended failed, a
 *     payout the provider rejected, a webhook event reconciliation gave up on.
 *   - Ordinary validation errors are NOT. A 400 for a malformed bank code is
 *     refused before money moves and must never land here — which is why
 *     nothing in the request-validation paths calls this module.
 *
 * What a record names: the rail, the order, and what failed. Never a NIN,
 * never bank details, never an amount — the same NDPA rule that keeps the NIN
 * out of every other persisted shape keeps it out of this one.
 *
 * Recording is best-effort by design, like `recordNgnOrder`: by the time it
 * runs, the failure has already happened and the caller has a response to
 * send. It never throws, and the Prometheus counter is incremented first so a
 * database outage dims the table but never the alert.
 */
import { prisma } from "../db";
import { moneyFailuresTotal } from "../metrics";

/**
 * The rails a failure can be on. Bounded on purpose — this is a metrics label
 * as well as a column, and an unbounded label makes /metrics grow until it
 * cannot be scraped. "unknown" is the reconciliation give-up, where the event
 * failed to resolve to a rail before the database answered.
 */
export const MONEY_FAILURE_RAILS = ["offramp", "onramp", "bill", "unknown"] as const;
export type MoneyFailureRail = (typeof MONEY_FAILURE_RAILS)[number];

/**
 * The kinds of failure worth waking somebody for. Bounded for the same reason
 * as the rails.
 */
export const MONEY_FAILURE_KINDS = [
  /** An offramp order ended failed: the naira payout did not complete. */
  "payout_rejected",
  /** An onramp or bill order ended failed, after the user paid. */
  "order_failed",
  /** A webhook event asserting money moved could not be applied to our rows. */
  "reconcile_failed",
] as const;
export type MoneyFailureKind = (typeof MONEY_FAILURE_KINDS)[number];

export function isMoneyFailureRail(value: unknown): value is MoneyFailureRail {
  return typeof value === "string" && (MONEY_FAILURE_RAILS as readonly string[]).includes(value);
}

export function isMoneyFailureKind(value: unknown): value is MoneyFailureKind {
  return typeof value === "string" && (MONEY_FAILURE_KINDS as readonly string[]).includes(value);
}

/**
 * Whether a provider status is a failure ending.
 *
 * Shares its vocabulary with `statusForClients`: an ending the wallet apps
 * treat as finished ("failed", "timeout", and the expire/cancel/reverse/refund
 * words that get mapped onto them) is exactly the set of endings worth
 * recording. Plus "reject", the provider's word for a refused payout.
 */
export function isFailureStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return ["fail", "reject", "timeout", "expire", "cancel", "revers", "refund"].some((word) =>
    s.includes(word),
  );
}

export interface RecordMoneyFailureParams {
  network: string;
  rail: MoneyFailureRail;
  kind: MoneyFailureKind;
  /** The provider's order id — what ties this record to the order it is about. */
  orderId: string;
  /** Our client-facing id, when the order has one (offramp orders). */
  publicId?: string | null;
  /** The provider's status/code, when the failure came with one. */
  providerCode?: string | null;
  /** What failed, in operator-facing words. Never personal data. */
  message: string;
}

/**
 * Write one failure down, or say loudly that we could not.
 *
 * **This never throws.** The failure it describes has already happened; a
 * bookkeeping error must not turn it into a second one on the caller's path
 * (the webhook handler answers before reconciling, and this runs after).
 *
 * Idempotent per (network, kind, order): a webhook redelivery and a status
 * poll describing the same failed order increment `occurrences` rather than
 * creating a second row. One failed payout is one incident — see
 * docs/idempotency.md for the same principle on the orders themselves.
 */
export async function recordMoneyFailure(params: RecordMoneyFailureParams): Promise<void> {
  const { network, rail, kind, orderId, publicId, providerCode, message } = params;

  // First, and in-process: if the database write below fails, the counter is
  // still the alert. A database outage dims the table, not the signal.
  moneyFailuresTotal.inc({ network, rail, kind });

  try {
    await prisma.moneyFailure.upsert({
      where: { network_kind_orderId: { network, kind, orderId } },
      create: {
        network,
        rail,
        kind,
        orderId,
        publicId: publicId ?? null,
        providerCode: providerCode ?? null,
        message,
      },
      update: {
        message,
        ...(providerCode != null ? { providerCode } : {}),
        ...(publicId != null ? { publicId } : {}),
        occurrences: { increment: 1 },
      },
    });
  } catch (err) {
    // Loud, because the incident record is now missing and only the metric
    // above can still raise the alarm. The error's name only: a database
    // error's message is not operator-facing prose and may carry details the
    // console should not have either.
    console.error(
      `[money-failures] could not record ${kind} for order ${orderId}:`,
      (err as Error)?.name ?? "unknown error",
    );
  }
}
