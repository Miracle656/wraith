/**
 * The naira rails: buying crypto with naira, and paying bills out of the wallet.
 *
 * Both sit behind this service because the Linq API key is the ability to spend
 * — it creates orders that move real naira — and anything in an APK is
 * extractable. The app never holds it.
 *
 * ## The order record, and why it grants no new read access
 *
 * These rails do keep a row (`NgnOrder`), but not for the reason the offramp
 * does. The offramp persists because it mints its own `publicId` and a bearer
 * token so a client can read an order back; `NgnOrder` exists because a bill's
 * outcome is ** off-chain*. An onramp delivering XLM lands as a payment the
 * indexer already sees and the address subscription already pushes — no row
 * needed to observe it. A biller refusing to vend after the user has paid is
 * invisible to the chain, so without a row `order.failed` arrives for an order
 * we cannot identify. See `../linq/ngnOrders.ts`.
 *
 * Reads are unchanged by it. Linq's status endpoints require **both**
 * `customerRef` and `orderId`, and return the same 404 for another customer's
 * order as for one that does not exist. `orderId` is an unguessable UUID, so
 * knowing someone's wallet address — which is semi-public — buys nothing on its
 * own. `findNgnOrder` enforces the same pairing locally and returns null for
 * another customer's row, so the local fallback cannot be used to get around it.
 *
 * What we must therefore never add is a route that lists orders by
 * `customerRef` alone, and the table deliberately has no index on that column
 * to keep it from looking cheap. That would turn a public identifier into a way
 * to read someone's bank details and amounts, and it is the one change here
 * that silently removes the protection.
 *
 * ## Mainnet only
 *
 * Linq has no sandbox: every call moves real money. A Stellar `G…` address is
 * valid on both networks, so an order placed from a testnet session would take
 * real naira and deliver real crypto to an address the testnet wallet never
 * displays. `assertOnrampNetwork` refuses that, and these routes apply it
 * before anything else.
 *
 * ## Naira amount scale
 *
 * The provider reported on 2026-10-14 that onramp naira amounts on their
 * dashboard, and `amountNGN` in their webhooks, had been 100× too small, and
 * that it was now corrected. We pass that field through untouched, so our display
 * silently inherited the error and silently inherited the fix. Nothing in this
 * service would have noticed either. The bound below exists so that a scale
 * change is a failed request or a flagged row, not a silent one.
 */

import { Router, Request, Response, NextFunction } from "express";
import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

import { requestNetwork } from "../middleware/network";
import { LinqError } from "../linq/client";
import { usdPerCoin } from "../linq/coinPrice";
import {
  assertOnrampNetwork,
  createOnrampOrder,
  getOnrampRate,
  getOnrampStatus,
  getCustomerStatus,
  provisionCustomer,
  submitCustomerKyc,
  type OnrampCoin,
} from "../linq/onramp";
import { getBillStatus, payBill, type BillCategory, type BillCoin } from "../linx/bills";
import { findNgnOrder, recordNgnOrder } from "../linq/ngnOrders";

function isConfigured(): boolean {
  return Boolean(process.env.LINQ_API_KEY?.trim());
}

/**
 * Linq's own message names the real problem — an unverified customer, an
 * unsupported coin — far netter than anything we would invent, so it is passed
 * through. A 5xx from them is ours to own as a 502: the caller did nothing
 * wrong.
 */
function sendLinqError(res: Response, err: unknown): void {
  if (err instanceof LinqError) {
    // `code` rides along when Linq sent one — `nin_already_used`,
    // `customer_not_verified`, and so on. Without it the clients are left
    // matching on the prose in `error`, which is how a reworded provider
    // message turns into a user sent down the wrong branch. `error` stays
    // exactly as it was, so nothing that reads it today breaks.
    // A 429  is not a failure the user can fix by reading a sentence, and the
    // clients collapse every rate-limit message into one guess at how long to
    // wait. `rate_limited` and the provider's own Retry-After replace the
    // guess: a tester hit this creating an order while the rate reads beside
    // it were succeeding, which is how we knew it was the provider's limit and
    // not ours — but only after reading the source.
    const rateLimited = err.status === 429;
    if (rateLimited && err.retryAfterSeconds !== undefined) {
      res.setHeader("Retry-After", String(err.retryAfterSeconds));
    }
    res.status(err.status >= 500 ? 502 : err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : rateLimited ? { code: "rate_limited" } : {}),
      ...(rateLimited && err.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: err.retryAfterSeconds }
        : {}),
    });
    return;
  }
  res.status(500).json({ error: "Request failed" });
}

/**
 * When Linq itself is unreachable, answer from our own record rather than
 * failing.
 *
 * Only for 502/504 — Linq being down or slow. A 4xx is Linq telling us
 * something true about the request (an unverified customer, an order that does
 * not exist) and must be passed through, not papered over with a stale row.
 *
 * The answer is marked `stale: true` so a client cannot mistake a last-known
 * status for a live one. A bill that was `initiated` when we last heard is not
 * evidence that it still is.
 */
async function fallbackToRecordedOrder(
  res: Response,
  err: unknown,
  network: string,
  customerRef: string,
  orderId: string,
): Promise<boolean> {
  if (!(err instanceof LinqError) || err.status < 500) return false;

  const recorded = await findNgnOrder(network, customerRef, orderId).catch(() => null);
  if (!recorded) return false;

  res.json({ ...recorded, stale: true, reason: "Linq is unreachable; this is our last known status" });
  return true;
}

/**
 * Limits how many lookups a client may get **wrong**.
 *
 * `skipSuccessfulRequests` means a wallet polling its own open order every few
 * seconds never spends the budget, while someone trying ids they do not own
 * exhausts it quickly.
 */
/**
 * How far a client's quoted rate may sit from ours before we refuse it.
 *
 * Wide enough that ordinary drift between fetching a rate and posting an order
 * never trips it — XLM floats, and a user may sit on a confirm screen. Narrow
 * enough that the mistake this exists for cannot pass: pricing XLM as a dollar
 * is a factor of roughly five, not a few percent.
 */
const RATE_TOLERANCE = 0.15;

/**
 * The plausible range for a naira amount on these rails, and the reason for it.
 *
 * The provider reported on 2026-10-14 that onramp naira amounts had been 100×
 * too small and were now corrected. We pass the field through untouched, so the
 * error and the fix both reached us silently. This bound is what makes a scale
 * change loud enough to notice.
 *
 * The numbers are justified, not magic:
 *
 * - The smallest thing anyone willingly buys or sells here is a few hundred
 *   naira — airtime top-ups start around ₆100 and the smallest crypto buy is
 *   on the order of ₂1,000. ₆10 is below any of that by an order of
 *   magnitude and is the shape a 100×-too-small bug takes.
 * - The largest single order anyone sends through a mobile onramp or a bill
 *   pay sits in the millions of naira, not the hundreds of millions. ₆500m
 *   is already an outlier for a retail rail and gives the bound room to be
 *   wrong in the generous direction without admitting a scale error.
 *
 * The range is therefore ₆10 to ₆500,000,000. A 100× drift in either direction
 * lands outside it for every realistic order, which is the point.
 */
const MIN_PLAUSIBLE_NGN = 10;
const MAX_PLAUSIBLE_NGN = 500_000_000;

/**
 * Whether a naira amount is inside the plausible range for an order.
 *
 * Exported so the webhook handler and the tests share one definition of the
 * bound. A non-finite or non-positive value is never plausible.
 */
export function isPlausibleNairaAmount(amountNGN: unknown): boolean {
  return (
    typeof amountNGN === "number" &&
    Number.finite(amountNGN) &&
    amountNGN >= MIN_PLAUSIBLE_NGN &&
    amountNGN <= MAX_PLAUSIBLE_NGN
  );
}

/**
 * The factor by which a webhook and its order may disagree and still be the
 * same order.
 *
 * The two numbers are known independently — the order's own naira amount was
 * set when we created it, and the webhook's `amountNGN` comes back from the
 * provider — so they can be cross-checked. The only difference that is not a
 * bug is rounding, so the tolerance is tight. A 100× scale error is not rounding.
 */
const NGN_CROSSCHECK_TOLERANCE = 0.01;

/**
 * Whether a webhook's `amountNGN` matches the order it claims to be about.
 *
 * Returns `true` when the two agree within the tolerance above. Both sides
 * must be plausible naira amounts themselves, so a webhook that is 100× off is
 * rejected even if the order record is also wrong.
 */
export function nggAmountMatches(
  webhookAmountNGN: unknown,
  orderAmountNGN: unknown,
): boolean {
  if (!isPlausibleNairaAmount(webhookAmountNGN)) return false;
  if (!isPlausibleNairaAmount(orderAmountNGN)) return false;
  const webhook = webhookAmountNGN as number;
  const order = orderAmountNGN as number;
  const diff = Math.abs(webhook - order) / order;
  return diff <= NGN_CROSSCHECK_TOLERANCE;
}

export const nggRouter = Router();
