/**
 * Server-side client for Linq's B2B offramp API.
 *
 * The API key creates orders that pay real naira to real bank accounts, so it
 * lives here and never leaves the backend. A mobile build cannot hold it:
 * anything in an APK is extractable, and this one is not rate-limited
 * read-only access — it is the ability to spend.
 *
 * Every call is narrow and returns typed data or throws {@link LinqError} with
 * Linq's own message, because their 400s explain the actual problem (bad bank
 * code, unsupported coin) far better than anything we would invent.
 */

import { LinqError, linqCall, retryOnProviderFailure, TOTAL_BUDGET_MS, type LinqCallOptions } from "./http";

// Re-exported so every existing import of these from `./client` keeps working.
export { LinqError, retryOnProviderFailure } from "./http";

/**
 * A provider 429 is retried this many times before it reaches the user.
 *
 * All Veil users share one provider key, and the provider limits it. A user
 * creating a cash-out got "rate limit exceeded, please wait" and succeeded on
 * a second tap: the limit had cleared within a second or two, so the app should
 * have waited, not the user. A 429 means the request was refused before any
 * work was done, so repeating it (order creation included, with the same
 * idempotencyKey) cannot create anything twice.
 */
const RATE_LIMIT_RETRIES = 2;

/** Every offramp request: the shared client, with this rail's 429 retry. */
function call<T>(path: string, options: LinqCallOptions = {}): Promise<T> {
  return linqCall<T>(path, { rateLimitRetries: RATE_LIMIT_RETRIES, ...options });
}

// ─── Rate ────────────────────────────────────────────────────────────────────

export interface LinqRate {
  rate: number;
  currency: string;
  coin: string;
}

/**
 * Indicative NGN rate. Unauthenticated, and explicitly for display only — the
 * binding rate is the one locked into an order at creation.
 */
export function getRate(): Promise<LinqRate> {
  return call<LinqRate>("/b2b/rate", { auth: false });
}

// ─── Bank verification ───────────────────────────────────────────────────────

export interface VerifiedBank {
  accountName: string;
  bankName: string;
  accountNumber: string;
  bankCode: string;
}

/**
 * Resolve an account number to the name the bank holds for it.
 *
 * Always called before creating an order: a wrong account name is a failed
 * payout after the USDC has already been sent, and the failure surfaces
 * minutes later in a webhook rather than while the user is still on screen.
 */
export function verifyBank(bankCode: string, accountNumber: string): Promise<VerifiedBank> {
  return call<VerifiedBank>("/b2b/verifybank", {
    method: "POST",
    body: { bankCode, accountNumber },
  });
}

// ─── Stellar trustline ───────────────────────────────────────────────────────

export interface TrustlineCheck {
  address: string;
  valid: boolean;
  trustsUSDC: boolean;
}

/**
 * Whether a Stellar account can receive USDC, for validating a refund address.
 *
 * Linq rejects muxed (M…) and CONTRACT (C…) addresses outright, which matters
 * here specifically: a Veil wallet is a contract account, so the refund address
 * must be the classic fee-payer, never the wallet address the user sees.
 *
 * A 503 means Horizon was unreachable — the answer is unknown, not "no". Linq's
 * own docs are explicit that rejecting on 503 turns a Stellar outage into a
 * failed sell, so that case resolves to "assume it can" and is checked again
 * before any refund is actually paid.
 */
export async function checkStellarTrustline(address: string): Promise<TrustlineCheck> {
  try {
    return await call<TrustlineCheck>(
      `/b2b/stellar/trustline?address=${encodeURIComponent(address)}`,
    );
  } catch (err) {
    if (err instanceof LinqError && err.status === 503) {
      return { address, valid: true, trustsUSDC: true };
    }
    throw err;
  }
}

// ─── Orders ──────────────────────────────────────────────────────────────────

export interface CreateOfframpParams {
  /** Exactly one of these two. */
  amountNGN?: number;
  amountStableCoin?: number;
  bankAccount: string;
  bankCode: string;
  bankName: string;
  accountName: string;
  /** Must already hold a USDC trustline. On Veil this is the fee-payer G-account. */
  refundAddress?: string;
  customerRef?: string;
  idempotencyKey: string;
}

export interface OfframpOrderResponse {
  id: string;
  walletAddress: string;
  coinType: string;
  coin: string;
  chain: string;
  amountStableCoin: number;
  amountNGN: number;
  rate: number;
  currency: string;
  status: string;
  depositDigest?: string;
}

/**
 * Create a Stellar USDC → NGN order.
 *
 * `chain: "stellar"` is sent explicitly and never inferred. Linq's default is
 * Sui, and `coin` does not select the chain — omitting it mints a Sui deposit
 * wallet even when the coin says USDC, and their docs warn that funds sent to
 * an address on the wrong chain are unrecoverable.
 *
 * `manualDeposit: true` because the payout should follow what actually
 * arrives. With the default the full locked NGN is paid out even if less USDC
 * turns up, and the shortfall is ours — a bad trade for a wallet that is not
 * taking FX risk, and the loss would land on whoever operates the Linq account
 * rather than the user who mistyped.
 */
export async function createOfframpOrder(
  params: CreateOfframpParams,
): Promise<OfframpOrderResponse> {
  const { amountNGN, amountStableCoin } = params;
  // async, so this surfaces as a rejection rather than a synchronous throw —
  // a caller awaiting the promise should not also need a try/catch around the
  // call itself.
  if ((amountNGN == null) === (amountStableCoin == null)) {
    throw new LinqError(
      "Provide exactly one of amountNGN or amountStableCoin",
      400,
    );
  }
  // One deadline for the attempt AND its retry, so the two budgets add up to
  // TOTAL_BUDGET_MS rather than multiplying.
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const request = () =>
  call<OfframpOrderResponse>("/b2b/offramp", {
    method: "POST",
    deadline,
    body: {
      ...params,
      chain: "stellar",
      coin: "usdc",
      currency: "NGN",
      manualDeposit: true,
    },
  });
  return retryOnProviderFailure(request, 1_500, deadline);
}

export interface OfframpStatus {
  id: string;
  status: string;
  amountStableCoin: number;
  amountNGN: number;
  currency: string;
  created: string;
  updated: string;
}

/** Poll an order. The settled amounts here are authoritative, not the request. */
export function getOfframpStatus(orderId: string): Promise<OfframpStatus> {
  return call<OfframpStatus>(`/b2b/status?id=${encodeURIComponent(orderId)}`);
}
