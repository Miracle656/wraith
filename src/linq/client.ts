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

const BASE_URL =
  process.env.LINQ_BASE_URL?.trim() ||
  "https://confidential-brianna-uselinq-52e2b233.koyeb.app";

const TIMEOUT_MS = 15_000;

export class LinqError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LinqError";
  }
}

function apiKey(): string {
  const key = process.env.LINQ_API_KEY?.trim();
  if (!key) throw new LinqError("LINQ_API_KEY is not configured", 500);
  return key;
}

/** A provider 429 is retried this many times before it reaches the user. */
const RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 3_000;

/**
 * Everything one logical provider operation may spend, retries included.
 *
 * Without this the budgets multiplied: three 15s attempts plus two 3s waits
 * is 51s inside `call`, and `retryOnProviderFailure` could run that whole
 * sequence twice — about 103 seconds on an order creation. The mobile client
 * gives up after 20s, so users were told "cash out is unavailable" while this
 * server was still working, and the order it went on to create never appeared
 * in the app. A server that answers a person has to finish before they are
 * told it failed, so this ceiling stays below every client timeout.
 */
const TOTAL_BUDGET_MS = 35_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CallInit = {
  method?: string;
  body?: unknown;
  auth?: boolean;
  /**
   * Absolute time (ms since epoch) this operation must be finished by.
   * Defaults to {@link TOTAL_BUDGET_MS} from the first attempt. Pass one
   * explicitly to share a single budget across several calls.
   */
  deadline?: number;
};
type RateLimited = LinqError & { retryAfterMs?: number };

/**
 * Every provider request, with rate limits absorbed.
 *
 * All Veil users share one provider key, and the provider limits it. A user
 * creating a cash-out got "rate limit exceeded, please wait" and succeeded on
 * a second tap: the limit had cleared within a second or two, so the app should
 * have waited, not the user. A 429 means the request was refused before any
 * work was done, so repeating it (order creation included, with the same
 * idempotencyKey) cannot create anything twice.
 */
async function call<T>(path: string, init: CallInit = {}): Promise<T> {
  const deadline = init.deadline ?? Date.now() + TOTAL_BUDGET_MS;

  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new LinqError("The payout service did not respond in time", 504);
    }

    try {
      // Never wait past the deadline, even on the first attempt: a call made
      // late in a shared budget gets what is left of it, not a fresh 15s.
      return await callOnce<T>(path, init, Math.min(TIMEOUT_MS, remaining));
    } catch (err) {
      if (!(err instanceof LinqError) || err.status !== 429 || attempt >= RATE_LIMIT_RETRIES) {
        throw err;
      }
      const wait = (err as RateLimited).retryAfterMs ?? Math.min(1_000 * (attempt + 1), MAX_RETRY_DELAY_MS);
      // A wait that would end after the deadline buys nothing; surface the 429.
      if (Date.now() + wait >= deadline) throw err;
      await sleep(wait);
    }
  }
}

async function callOnce<T>(
  path: string,
  init: CallInit,
  timeoutMs: number = TIMEOUT_MS,
): Promise<T> {
  const { method = "GET", body, auth = true } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        ...(auth ? { "X-API-Key": apiKey() } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    // An error body is not always JSON. A plain-text "Rate limit exceeded"
    // used to throw inside JSON.parse, turning a retryable 429 into a 502
    // whose message was the parser's complaint about the text.
    let parsed: unknown = {};
    try {
      parsed = text ? (JSON.parse(text) as unknown) : {};
    } catch {
      if (res.ok) throw new LinqError("Linq returned a malformed response", 502);
      parsed = { message: text.trim() };
    }
    if (!res.ok) {
      const message =
        (parsed as { message?: string })?.message || `Linq returned ${res.status}`;
      const header = res.headers?.get?.("retry-after");
      const seconds = header == null ? Number.NaN : Number(header);
      throw Object.assign(new LinqError(message, res.status), {
        retryAfterMs: Number.isFinite(seconds)
          ? Math.min(Math.max(0, seconds) * 1_000, MAX_RETRY_DELAY_MS)
          : undefined,
      });
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof LinqError) throw err;
    if ((err as Error)?.name === "AbortError") {
      throw new LinqError("Linq did not respond in time", 504);
    }
    throw new LinqError((err as Error)?.message ?? "Linq request failed", 502);
  } finally {
    clearTimeout(timer);
  }
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

/**
 * One retry when the provider fails on its side: a 5xx, or no response.
 *
 * Order creation can fail transiently at the provider — "Wallet generation
 * failed" is it not managing to mint the deposit address — and the user was
 * shown that and left to try again by hand. A 4xx is about the request and
 * is never retried. The retry sends the identical body, idempotencyKey
 * included, so the provider can recognise it as the same order.
 *
 * `deadline` bounds the pair. Without it the retry doubled the caller's whole
 * budget, which is how a 35s ceiling silently became 70.
 */
export async function retryOnProviderFailure<T>(
  request: () => Promise<T>,
  delayMs = 1500,
  deadline?: number,
): Promise<T> {
  try {
    return await request();
  } catch (err) {
    if (!(err instanceof LinqError) || err.status < 500) throw err;
    // No point sleeping into a deadline we cannot then do work before.
    if (deadline !== undefined && Date.now() + delayMs >= deadline) throw err;
    await sleep(delayMs);
    return request();
  }
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
