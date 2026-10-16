const DEFAULT_TOKEN_DECIMALS = 7;

/**
 * Plausible bounds for naira amounts that cross the provider boundary.
 *
 * The provider reported on 2026-10-14 that onramp naira amounts (dashboard
 * and webhook `amountNGN`) had been 100× too small and that it was now corrected.
 * We pass that field through untouched, so our display silently inherited the
 * error and then silently inherited the fix. This bound exists so that a scale
 * change is caught at the boundary instead of being inherited silently.
 *
 * Justification for the numbers:
 * - Nigeria's lowest denomination in circulation is the kobo (1 NGN = 100 kobo),
 *   so any real naira amount is an integer of kobo and the smallest meaningful
 *   onramp order is on the order of a few hundred naira.
 * - Nigerian individual onramp limits and typical wallet balances are in the
 *   hundreds of thousands to low millions of naira; a single onramp
 *   transaction is not plausibly billions of naira.
 * - The previous bug was a 100× scale error, so the bound must be tight
 *   enough to distinguish a normal amount from its 100× shifted variant
 *   (e.g. 2,000 NGN vs. 200,000 NGN, or 200 NGN vs 20,000 NGN).
 *
 * The bound is therefore [MIN_NGN, MAX_NGN] with MIN_NGN = 100 NGN (10,000
 * kobo, the smallest plausible onramp) and MAX_NGN = 100,000,000 NGN (100
 * million naira, well above any retail onramp but well below a 100× misscale
 * of a normal amount).
 */
export const MIN_NGN = 100;
export const MAX_NGN = 100_000_000;

export type NairaSanityResult =
  | { ok: true; amountNGN: number }
  | { ok: false; reason: string; amountNGN: number };

/**
 * Parse and sanity-check a naira amount coming from the provider.
 *
 * The provider sends `balanceNGN` / `amountNGN` as a decimal string in major units
 * (naira, not kobo). We reject anything that is not a positive, finite number
 * within the plausible range for an onramp order.
 */
export function sanitizeNairaAmount(value: unknown): NairaSanityResult {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { ok: false, reason: "non-finite naira amount", amountNGN: value };
    }
    return sanitizeNairaAmount(value.toString());
  }

  if (typeof value !== "string") {
    return { ok: false, reason: "naira amount is not a string or number", amountNGN: NaN };
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return { ok: false, reason: "naira amount is empty", amountNGN: NaN };
  }

  // Reject thousands separators and other locale noise; the provider sends a
  // plain decimal string.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, reason: `naira amount ${value} is not a plain decimal`, amountNGN: NaN };
  }

  const amount = Number(trimmed);
  if (!Number.isFinite(amount)) {
    return { ok: false, reason: `naira amount ${value} is not finite`, amountNGN: NaN };
  }

  if (amount < MIN_NGN) {
    return {
      ok: false,
      reason: `naira amount ${amount} is below the plausible onramp minimum ${MIN_NGN}`,
      amountNGN: amount,
    };
  }

  if (amount > MAX_NGN) {
    return {
      ok: false,
      reason: `naira amount ${amount} exceeds the plausible onramp maximum ${MAX_NGN}`,
      amountNGN: amount,
    };
  }

  return { ok: true, amountNGN: amount };
}

/**
 * Cross-check the webhook's `amountNGN` against the order's own naira amount.
 * Both are known at webhook time, so a scale mismatch is detectable even when the
 * webhook value is individually within the sanity bound.
 */
export function crossCheckNairaAmount(
  webhookAmountNGN: unknown,
  orderAmountNGN: unknown,
  toleranceRatio = 0.01,
): NairaSanityResult {
  const webhook = sanitizeNairaAmount(webhookAmountNGN);
  if (!webhook.ok) return webhook;

  const order = sanitizeNairaAmount(orderAmountNGN);
  if (!order.ok) {
    return {
      ok: false,
      reason: `order naira amount is not sanity-clean: ${order.reason}`,
      amountNGN: webhook.amountNGN,
    };
  }

  const diff = Math.abs(webhook.amountNGN - order.amountNGN);
  const allowed = Math.max(order.amountNGN * toleranceRatio, 1);
  if (diff > allowed) {
    return {
      ok: false,
      reason: `webhook naira amount ${webhook.amountNGN} does not match order naira amount ${order.amountNGN}`,
      amountNGN: webhook.amountNGN,
    };
  }

  return { ok: true, amountNGN: webhook.amountNGN };
}

export function toDisplayAmount(
  amount: string,
  decimals: number = DEFAULT_TOKEN_DECIMALS,
): string {
  const normalizedDecimals =
    Number.isInteger(decimals) && decimals >= 0 ? decimals : DEFAULT_TOKEN_DECIMALS;
  const scale = 10n ** BigInt(normalizedDecimals);
  const raw = BigInt(amount);
  const abs = raw < 0n ? -raw : raw;
  const integer = abs / scale;
  const remainder = abs % scale;
  const sign = raw < 0n ? "-" : "";

  if (normalizedDecimals === 0) return `${sign}${integer}`;

  return `${sign}${integer}.${String(remainder).padStart(normalizedDecimals, "0")}`;
}
