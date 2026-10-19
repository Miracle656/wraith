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
 * delivers XLM or USDC for an onramp, the indexer sees the payment arrive at
 * the wallet's classic account and the existing address subscription already
 * pushes it, so the onramp never needed a row to be observable. A biller
 * vending airtime — or refusing to, after the user has already paid — is
 * invisible to the chain. Without a row, `order.failed` arrives for an order we
 * cannot identify and the only thing that ever learns about the failure is a
 * client that happens to poll.
 *
 * ## What is deliberately not here
 *
 * **`customerId`** — the phone number for airtime, the meter number for
 * electricity. It is passed straight through to Linq at creation and never
 * stored, for the same reason the NIN never is: it is personal data under the
 * NDPA, and the cheapest way to hold it correctly is not to hold it.
 *
 * **Any lookup by `customerRef` alone.** There is no index on that column and
 * no function here that takes it without an `orderId`.
 */

import { prisma } from "../db";

export type NgnOrderKind = "onramp" | "bill";

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

  const data = {
    kind,
    customerRef,
    walletAddress,
    coin,
    amountStableCoin: String(amountStableCoin),
    amountNGN: String(amountNgn),
    rate: String(rate),
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

  await prisma.ngnOrder.update({
    where: { network_orderId: { network: existing.network, orderId: event.orderId } },
    data: {
      status: event.status ?? event.event,
      ...(event.amountStableCoin != null
        ? { settledStableCoin: String(event.amountStableCoin) }
        : {}),
      ...(event.amountNGN != null ? { settledNGN: String(event.amountNGN) } : {}),
      ...(event.txHash ? { txHash: event.txHash } : {}),
    },
  });
  return true;
}
