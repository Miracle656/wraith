/**
 * Local records of onramp and bill orders.
 *
 * ## Why these are recorded at all, when the module header for `api/ngn.ts`
 * argues against a table
 *
 * That argument still holds for *reads*: Linq's status endpoints require both
 * `customerRef` and `orderId`, which is the property that stops a semi-public
 * wallet address being enough to read someone's order. Nothing here weakens
 * that, and {@link findNgnOrder} enforces it.
 *
 * What changed is the **webhook**. A bill's outcome is off-chain: when Linq
 * delivers XLM or USDC for an onramp, the indexer sees the payment arrive at the
 * wallet's classic account and the existing address subscription already
 * pushes it, so the onramp never needed a row to be observable. A biller
 * vending airtime — or refusing to, after the user has already paid — is
 * invisible to the chain. Without a row, `order.failed` arrives for an order we
 * cannot identify and the only thing that ever learns about the failure is a
 * client that happens to poll.
 *
 * ## What is deliberately not here
 *
 * **`customerId** — the phone number for airtime, the meter number for
 * electricity. It is passed straight through to Linq at creation and never
 * stored, for the same reason the NIN never is: it is personal data under the
 * NDPA, and the cheapest way to hold it correctly is not to hold it.
 *
 * **Any lookup by `customerRef` alone.** There is no index on that column and
 * no function here that takes it without an `orderId`.
 */

import { prisma } from "../db";

export type NgnOrderKind = "onramp" | "bill";

/**
 * Sanity bounds on naira amounts crossing the Linq boundary.
 *
 * The provider reported on 2026-10-14 that onramp naira amounts were 100×
 * too small and that it was now corrected. We pass the field through untouched,
 * so our display silently inherited the error and silently inherited the fix.
 *
 * ## Why these numbers, and not magic
 *
 * The naira rails are mainnet-only and have no sandbox, and the orders that
 * cross this boundary are consumer sized. The bound is derived from the coin
 * side of the same order, which we also know, rather than from a bare limit:
 *
 *   - The smallest order this rail accepts is on the order of a few hundred
 *     naira, and the largest is on the order of a few million. The ratios below
 *     span that range with room for both directions.
 *   - The ratio is the thing that actually broke: 100× is a factor of 100 outside
 *     any plausible ratio, while a genuine order sits well inside it. So the
 *     check is on the ratio of naira to stablecoin, not on either amount alone.
 *   - The absolute floor and ceiling exist only to catch a zero or a negative
 *     or an absurd value that would otherwise pass the ratio check.
 *
 * The bound is applied in both directions: on the way in (what we send to
 * Linq) and on the way out (what the webhook tells us). A value outside the
 * bound is flagged and rejected, not stored silently.
 */

export const NGN_AMOUNT_BOUNDS = {
  /** Smallest plausible naira amount for a consumer order. */
  minNga: 100,
  /** Largest plausible naira amount for a consumer order. */
  maxNga: 50_000_000,
  /** Minimum plausible naira-per-stablecoin ratio. */
  minRatio: 50,
  /** Maximum plausible naira-per-stablecoin ratio. */
  maxRatio: 5_000,
} as const;

/**
 * Result of a naira sancity check.
 */
export interface NgnAmountCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Check a naira amount against the coin amount it was quoted for.
 *
 * The ratio is the check that matters: a 100× scale error leaves the
 * individual amounts within the absolute bound but moves the ratio by two
 * orders of magnitude. The absolute bound catches zero, negative, and
 * absurd values that would otherwise pass the ratio check.
 */
export function checkNgnAmount(
  amountNgn: number | string,
  amountStableCoin?: number | string,
): NgnAmountCheck {
  const nga = Number(amountNgn);
  const stable = Number(amountStableCoin);

  if (!Number.isFinite(nga) || nga <= 0) {
    return { ok: false, reason: `naira amount is not a positive finite number: ${amountNgn}` };
  }
  if (nga < NGN_AMOUNT_BOUNDS.minNga || nga > NGN_AMOUNT_BOUNDS.maxNga) {
    return {
      ok: false,
      reason: `naira amount ${nga} is outside the plausible range [${NGN_AMOUNT_BOUNDS.minNga}, ${NGN_AMOUNT_BOUNDS.maxNga}]`,
    };
  }

  // The coin side is optional in the webhook payload; when it is missing we
  // can only apply the absolute bound. When it is present, the ratio is the
  // check that catches a scale error.
  if (amountStableCoin === undefined || amountStableCoin === null) {
    return { ok: true };
  }
  if (!Number.isFinite(stable) || stable <= 0) {
    return { ok: false, reason: `stablecoin amount is not a positive finite number: ${amountStableCoin}` };
  }

  const ratio = nga / stable;
  if (ratio < NGN_AMOUNT_BOUNDS.minRatio || ratio > NGN_AMOUNT_BOUNDS.maxRatio) {
    return {
      ok: false,
      reason: `naira/stablecoin ratio ${ratio.toFixed(2)} is outside the plausible range [${NGN_AMOUNT_BOUNDS.minRatio}, ${NGN_AMOUNT_BOUNDS.maxRatio}]`,
    };
  }

  return { ok: true };
}

export interface RecordNgnOrderParams {
  network: string;
  kind: NgnOrderKind;
  /** Linq's order id. */
  orderId: string;
  customerRef: string;
  /** Onramp: the delivery address. Bill: the refund address. Always `G…`. */
  walletAddress: string;
  coin: string;
  amountStableCoin: number | string;
  amountNgn: number | string;
  rate: number | string;
  status?: string;
  billCategory?: string;
  provider?: string;
}

/**
 * Write the order down, or say loudly that we could not.
 *
 * **This never throws.** By the time it runs, Linq has already created the
 * order and the caller is holding bank details or a deposit address that the
 * user needs. Failing their request because our bookkeeping failed would turn a
 * placed order into an error message, and they would reasonably place it again.
 *
 * The naira amount is checked against the coin amount before the row
 * is written. A value outside the plausible bound is not stored silently: it is
 * logged and the row is still written with the amount we were given, because
 * the order exists at Linq and we need the handle for its webhook. The flag
 * is the point; the caller and the logs can see it.
 *
 * Idempotent on `(network, orderId)`, so a retried delivery or a double-submit
 * updates the row rather than creating a second one.
 */
export async function recordNgnOrder(params: RecordNgnOrderParams): Promise<void> {
  const {
    network,
    kind,
    orderId,
    customerRef,
    walletAddress,
    coin,
    amountStableCoin,
    amountNgn,
    rate,
    status,
    billCategory,
    provider,
  } = params;

  const check = checkNgnAmount(amountNgn, amountStableCoin);
  if (!check.ok) {
    // Loud, because a scale error here is the exact failure this bound
    // exists to catch. We still write the row below — the order exists at
    // Linq and the webhook needs a handle — but the flag is visible.
    console.error(
      `[linq] naira amount out of bound for ${kind} order ${orderId}: ${check.reason}`,
    );
  }

  const data = {
    kind,
    customerRef,
    walletAddress,
    coin,
    amountStableCoin: String(amountStableCoin),
    amountNGN: String(amountNgn),
    rate: String(rate),
    // The flag is written with the row so a reader can tell the amount
    // was out of bound without having to scrape the logs.
    ...(!check.ok ? { amountFlagged: true } : {}),
    ...(status ? { status } : {}),
    ...(billCategory ? { billCategory } : {}),
    ...(provider ? { provider } : {}),
  };

  try {
    await prisma.ngnOrder.upsert({
      where: { network_orderId: { network, orderId } },
      create: { network, orderId, ...data },
      update: data,
    });
  } catch (err) {
    // Loud, because the order exists at Linq and we have just lost our only
    // handle on its webhook. The status poll still works — it goes to Linq, not
    // to us — so this degrades to the behaviour we had before this table.
    console.error(`[linq] could not record ${kind} order ${orderId}:`, err);
  }
}

/**
 * Read one order back.
 *
 * Both identifiers are required and the `customerRef` is matched, not merely
 * accepted. A row belonging to another customer is returned as `null` —
 * indistinguishable from one that does not exist, which is the same thing
 * Linq's own 404 does and the property this whole rail depends on.
 */
export async function findNgnOrder(
  network: string,
  customerRef: string,
  orderId: string,
): Promise<{
  orderId: string;
  status: string;
  kind: string;
  coin: string;
  amountStableCoin: string;
  amountNGN: string;
  rate: string;
  billCategory: string | null;
  provider: string | null;
  settledStableCoin: string | null;
  settledNGN: string | null;
  txHash: string | null;
  updatedAt: Date;
} | null> {
  if (!customerRef || !orderId) return null;

  const row = await prisma.ngnOrder.findUnique({
    where: { network_orderId: { network, orderId } },
  });
  if (!row || row.customerRef !== customerRef) return null;

  return {
    orderId: row.orderId,
    status: row.status,
    kind: row.kind,
    coin: row.coin,
    amountStableCoin: row.amountStableCoin,
    amountNGN: row.amountNGN,
    rate: row.rate,
    billCategory: row.billCategory,
    provider: row.provider,
    settledStableCoin: row.settledStableCoin,
    settledNGN: row.settledNGN,
    txHash: row.txHash,
    updatedAt: row.updatedAt,
  };
}

/**
 * Apply a webhook event to an order we placed.
 *
 * Returns false when the order is not ours, so the caller can say so rather
 * than silently succeeding. Nothing here creates a row: an event for an order
 * we never placed is not ours to act on.
 *
 * The webhook's `amountNGN` is cross-checked against the order's own naira
 * amount, since both are known. A 100× discrepancy is the exact failure this
 * bound exists to catch. When the cross-check fails, the event is not
 * applied to the row and the caller is told to flag it.
 */
export async function reconcileNgnOrder(event: {
  orderId: string;
  status?: string;
  event: string;
  amountStableCoin?: number;
  amountNGN?: number;
  txHash?: string;
}): Promise<boolean> {
  const existing = await prisma.ngnOrder.findFirst({ where: { orderId: event.orderId } });
  if (!existing) return false;

  // The webhook carries both amounts. When the naira amount is present, it
  // must agree with the order's own naira amount — both are known, so a
  // disagreement is a scale error or a spoofed event, and neither should be
  // stored silently. We also apply the absolute bound to the incoming value
  // independently of the order's own amount.
  if (event.amountNGN != null) {
    const incoming = checkNgnAmount(event.amountNGN, event.amountStableCoin);
    if (!incoming.ok) {
      console.error(
        `[linq] webhook naira amount out of bound for order ${event.orderId}: ${incoming.reason}`,
      );
      return false;
    }

    const orderNga = Number(existing.amountNGN);
    if (Number.isFinite(orderNga) && orderNga > 0) {
      const ratio = event.amountNGN / orderNga;
      // Within a factor of two is tolerance for rounding and fee adjustments;
      // a 100× scale error is a factor of 100 and is well outside it.
      if (ratio < 0.5 || ratio > 2) {
        console.error(
          `[linq] webhook naira amount ${event.amountNGN} disagrees with order ${event.orderId} own ${existing.amountNGN} (ratio ${ratio.toFixed(2)})`,
        );
        return false;
      }
    }
  }

  await prisma.ngnOrder.update({
    where: { network_orderId: { network: existing.network, orderId: event.orderId } },
    data: {
      status: event.status ?? event.event,
      ...(event.amountStableCoin != null
        ? { settledStableCoin: String(event.amountStableCoin) }
        : {}),
      ...(event.amountNGN != null ? { settledNGN: String(event.amountNGN) } : {}),
      ...(event.txHash != null ? { txHash: event.txHash } : {}),
    },
  });

  return true;
}
