import { Router, type Request, type Response } from "express";

/**
 * What Veil charges, answered by the server so the number is never in an APK.
 *
 * The fee itself is collected on-chain, in the same transaction as the thing
 * the user is doing — Linq confirmed on 2026-09-30 that they have no developer
 * fee structure, and the money never passes through wraith in either
 * direction, so there is nothing here to deduct from. What this endpoint does
 * is tell the client what to charge and where to send it.
 *
 * That split is the point. An amount compiled into the app can only be changed
 * by building, shipping and waiting for every user to update; a waiver, a
 * promotion or a correction then costs days. Here it is an environment
 * variable.
 */

/** A classic `G…` account. Contracts cannot be paid by a classic payment op. */
function isClassicAddress(value: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(value);
}

export interface PlatformFee {
  /**
   * Whole units of the fee asset, as a decimal string — what to charge.
   *
   * When the caller passed the amount being sent this is computed for it;
   * without one it is the floor, which is what a client too old to send an
   * amount will charge. That fallback is deliberately the smallest honest
   * number rather than the largest: an old client undercharging costs us, and
   * overcharging costs the user.
   */
  amount: string;
  assetCode: string;
  /** Null for native XLM, which has no issuer. */
  assetIssuer: string | null;
  destination: string;
  /** Percent of the sent amount, when the fee scales. Absent when it is flat. */
  percent?: string;
  /** Floor and cap, present only alongside `percent`. */
  min?: string;
  max?: string;
}

/** Stellar carries seven decimal places; anything beyond them cannot be sent. */
const STROOP_DP = 7;

function validRate(value: string | undefined): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  const rate = Number(raw);
  // A fee over 100% is always a misconfiguration, and charging it would take
  // more than the user is sending.
  return Number.isFinite(rate) && rate > 0 && rate <= 100 ? rate : null;
}

/**
 * The fee for sending `sent`, as a decimal string.
 *
 * Rounded DOWN to stroop precision. Rounding is a choice about who absorbs the
 * remainder, and on a charge the user did not ask for it should not be them.
 * The floor is applied afterwards, so rounding down can never produce a fee of
 * zero where one was configured.
 */
export function feeForAmount(
  sent: number,
  policy: { percent: number; min: number | null; max: number | null },
): string {
  const raw = (sent * policy.percent) / 100;
  const factor = 10 ** STROOP_DP;
  let fee = Math.floor(raw * factor) / factor;
  if (policy.max !== null) fee = Math.min(fee, policy.max);
  if (policy.min !== null) fee = Math.max(fee, policy.min);
  return fee.toFixed(STROOP_DP).replace(/0+$/, '').replace(/\.$/, '');
}

function validAmount(value: string | undefined): string | null {
  const amount = value?.trim();
  if (!amount) return null;
  if (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) return null;
  return amount;
}

/**
 * The fee for each asset we charge on, keyed by asset code.
 *
 * Per asset, and always **in the asset being sent**. Charging 0.1 USDC on an
 * XLM transfer would need a second balance the sender may not have and a
 * trustline they may not hold — and because the fee rides in the same
 * transaction as the payment, a fee they cannot cover would take their actual
 * payment down with it. A fee denominated in what they are already sending is
 * payable by definition: if they can send it, they can pay it.
 *
 * Every malformed entry is dropped rather than guessed at. A fee is a payment
 * the user did not ask for; if we cannot say exactly what it is and where it
 * goes, we do not charge it.
 */
export function configuredFees(sentAmount?: number): Record<string, PlatformFee> {
  const destination = process.env.VEIL_FEE_DESTINATION?.trim();
  if (!destination || !isClassicAddress(destination)) return {};

  const fees: Record<string, PlatformFee> = {};
  const percent = validRate(process.env.VEIL_FEE_PERCENT);

  /**
   * One asset's entry, flat or proportional.
   *
   * A flat fee is regressive here and the numbers are stark: 0.1 USDC is 10%
   * of a 1 USDC send and 0.01% of a 1,000 one, so the people being onboarded
   * with a thousand naira pay the heaviest rate while large senders pay
   * nothing worth naming. A percent with a floor and a cap keeps the small
   * sends cheap without making the large ones punitive.
   */
  const entry = (code: string, issuer: string | null, flat: string | null, min: string | null, max: string | null): PlatformFee | null => {
    if (percent === null) {
      // No rate configured: the flat amount, exactly as before.
      return flat ? { amount: flat, assetCode: code, assetIssuer: issuer, destination } : null;
    }
    const floor = min ? Number(min) : flat ? Number(flat) : null;
    const cap = max ? Number(max) : null;
    // Without an amount to price, answer with the floor — see `amount` above.
    const amount =
      sentAmount !== undefined && Number.isFinite(sentAmount) && sentAmount > 0
        ? feeForAmount(sentAmount, { percent, min: floor, max: cap })
        : (floor ?? 0).toFixed(STROOP_DP).replace(/0+$/, '').replace(/\.$/, '');
    if (!validAmount(amount)) return null;
    return {
      amount,
      assetCode: code,
      assetIssuer: issuer,
      destination,
      percent: String(percent),
      ...(floor !== null ? { min: String(floor) } : {}),
      ...(cap !== null ? { max: String(cap) } : {}),
    };
  };

  // USDC, or whichever issued asset VEIL_FEE_ASSET_CODE names.
  const issuedCode = process.env.VEIL_FEE_ASSET_CODE?.trim() || "USDC";
  const issuer = process.env.VEIL_FEE_ASSET_ISSUER?.trim();
  if (issuer && isClassicAddress(issuer)) {
    const fee = entry(
      issuedCode,
      issuer,
      validAmount(process.env.VEIL_FEE_AMOUNT),
      validAmount(process.env.VEIL_FEE_MIN),
      validAmount(process.env.VEIL_FEE_MAX),
    );
    if (fee) fees[issuedCode] = fee;
  }

  // Native XLM, which has no issuer and needs no trustline.
  const xlm = entry(
    "XLM",
    null,
    validAmount(process.env.VEIL_FEE_AMOUNT_XLM),
    validAmount(process.env.VEIL_FEE_MIN_XLM),
    validAmount(process.env.VEIL_FEE_MAX_XLM),
  );
  if (xlm) fees["XLM"] = xlm;

  return fees;
}

export function feesRouter(): Router {
  const router = Router();

  /**
   * Unauthenticated and uncached: it carries no personal data, and a stale
   * fee is one a user was shown but did not agree to.
   */
  router.get("/", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    // `?amount=` is the amount being sent, so the fee can scale with it. A
    // client too old to send one gets the floor, which is why this is optional
    // rather than required: the shipped APKs predate it and must keep working.
    const raw = Number(String(req.query["amount"] ?? ""));
    const sent = Number.isFinite(raw) && raw > 0 ? raw : undefined;
    const fees = configuredFees(sent);
    const assets = Object.keys(fees);
    // `enabled: false` rather than a 404, so a client can tell "no fee today"
    // from "this backend is too old to know about fees" and does not read a
    // deliberate waiver as a failure.
    res.json(assets.length > 0 ? { enabled: true, fees } : { enabled: false, fees: {} });
  });

  return router;
}
