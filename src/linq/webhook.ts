import crypto from "node:crypto";

/**
 * Verification for Linq's offramp webhooks.
 *
 * Linq signs the RAW request body with HMAC-SHA256 under a webhook secret that
 * is separate from the API key, and sends it as `X-Linq-Signature:
 * sha256=<hex>`. The signature is over the exact bytes they sent, so anything
 * that parses and re-serialises the body first — `express.json()`, which wraith
 * applies globally — destroys the ability to check it. The route must be
 * mounted with `express.raw()` ahead of that middleware.
 *
 * This matters more than the usual "verify your webhooks" advice: the endpoint
 * is public, and the events it carries say money moved. Anyone who can POST to
 * it could otherwise mark an order settled.
 */

/** Header Linq signs with. */
export const SIGNATURE_HEADER = "x-linq-signature";

export function computeSignature(rawBody: Buffer | string, secret: string): string {
  return (
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex")
  );
}

/**
 * Whether `signature` authenticates `rawBody` under `secret`.
 *
 * Compared with `timingSafeEqual`, which requires equal lengths — a mismatched
 * length would otherwise throw rather than return false, turning a malformed
 * signature into a 500 and telling the sender their guess was the wrong shape.
 */
export function verifySignature(
  rawBody: Buffer | string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = computeSignature(rawBody, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The shape Linq posts. Amounts are numbers on the wire. */
export interface LinqWebhookEvent {
  event: "order.processing" | "order.completed" | "order.failed";
  orderId: string;
  amountStableCoin?: number;
  amountNGN?: number;
  amountFormatted?: string;
  currency?: string;
  chain?: string;
  txHash?: string;
  status?: string;
  timestamp?: string;
}

/**
 * Plausible bounds for naira amounts on an onramp/offramp order.
 *
 * Justification (not a magic number):
 *   - Nigeria's per-transaction real-time bank transfer limits are in the low
 *     millions of naira; the CBN daily outbound cap for retail accounts is
 *     on the order of ₦10m. An individual onramp order therefore lives
 *     comfortably below ₅100,000,000 (100 million).
 *   - The bottom bound is the smallest unit that makes economic sense for a
 *     stablecoin-linked order: …100 (100 naira). Below that the fees dominate
 *     the transfer and the order is almost certainly a scale bug.
 *   - The 2026-10-14 incident was exactly a 100× scale error, so the bounds
 *     are chosen to be wide enough to accept legitimate orders but narrow
 *     enough that a 100× drift in either direction falls outside them.
 */
export const MIN_PLAUSIBLE_NGN = 100;
export const MAX_PLAUSIBLE_NGN = 100_000_000;

/**
 * The factor by which the provider scale was observed to be wrong on
 * 2026-10-14. Used to detect the old scale in stored rows and in tests.
 */
export const NGN_SCALE_FACTOR = 100;

/**
 * Whether a naira amount is plausible for an order of this size.
 *
 * This is a safety check, not a business rule: the goal is to notice a scale
 * change (like the 100× incident) before it is stored or displayed.
 */
export function isPlausibleNgn(amountNGN: number | undefined): boolean {
  if (typeof amountNGN !== "number" || !Number.isFinite(amountNGN)) return false;
  return amountNGN >= MIN_PLAUSIBLE_NGN && amountNGN <= MAX_PLAUSIBLE_NGN;
}

/**
 * Result of cross-checking a webhook's `amountNGN` against the order's own
 * naira amount. Both values are known at this point, so a disagreement is a
 * signal, not an ambiguity.
 */
export type NgnCrossCheckResult =
  | { ok: true }
  | { ok: false; reason: string; factor?: number };

/**
 * Cross-check the webhook's `amountNGN` against the order's own naira amount.
 *
 * The order amount is the authoritative value wraith created the order with;
 * the webhook value is what the provider claims happened. They must agree.
 *
 * When they disagree by exactly the historical 100× factor, we report that
 * explicitly so the caller can flag it as the known provider scale bug.
 */
export function crossCheckAmountNgn(webhookAmountNGN: number | undefined, orderAmountNGN: number | undefined): NgnCrossCheckResult {
  if (typeof webhookAmountNGN !== "number" || !Number.isFinite(webhookAmountNGN)) {
    return { ok: false, reason: "webhook amountNGN missing or non-numeric" };
  }
  if (typeof orderAmountNGN !== "number" || !Number.isFinite(orderAmountNGN)) {
    return { ok: false, reason: "order amountNGN missing or non-numeric" };
  }
  if (orderAmountNGN <= 0) {
    return { ok: false, reason: "order amountNGN not positive" };
  }
  if (webhookAmountNGN === orderAmountNGN) return { ok: true };

  const ratio = webhookAmountNGN / orderAmountNGN;
  const factor = ratio >= 1 ? ratio : 1 / ratio;
  if (Math.abs(factor - NGN_SCALE_FACTOR) < 0.01) {
    return {
      ok: false,
      reason: `webhook amountNGN is ${NGN_SCALE_FACTOR}× off the order (provider scale bug)`,
      factor: NGN_SCALE_FACTOR,
    };
  }
  return {
    ok: false,
    reason: `webhook amountNGN (${webhookAmountNGN}) disagrees with order amountNGN (${orderAmountNGN})`,
    factor,
  };
}

/**
 * Parse a verified body into an event, or null when it is not one.
 *
 * Signature verification proves the sender, not the shape — a valid signature
 * over malformed JSON is still malformed.
 */
export function parseEvent(rawBody: Buffer | string): LinqWebhookEvent | null {
  try {
    const parsed = JSON.parse(rawBody.toString("utf8" as BufferEncoding));
    if (!parsed || typeof parsed !== "object") return null;
    const { event, orderId } = parsed as Record<string, unknown>;
    if (typeof event !== "string" || typeof orderId !== "string") return null;
    if (
      event !== "order.processing" &&
      event !== "order.completed" &&
      event !== "order.failed"
    ) {
      return null;
    }
    return parsed as LinqWebhookEvent;
  } catch {
    return null;
  }
}
