/**
 * Server-side client for Linq's **B2B-native** bill payments, funded by Stellar.
 *
 * Airtime, data, electricity, cable TV and betting top-ups, paid for out of the
 * user's own Veil wallet.
 *
 * ## Why this is the better of the two NGN flows
 *
 * The onramp makes the user leave the app: we hand them bank details and they
 * go to their banking app to transfer naira. Bills are the reverse — the
 * deposit is *crypto*, from a wallet we already hold the signer for, so the
 * whole thing happens in one place and the user never leaves. That is why it
 * ships first.
 *
 * ## The two field traps in this API
 *
 * **`xlm` is omitted, never `false`.** Linq's docs are explicit: for USDC you
 * "drop `xlm` entirely rather than setting it to `false`". A literal
 * `xlm: false` is not the documented way to ask for USDC, and this endpoint
 * moves money, so {@link buildCoinFields} omits the key rather than trusting
 * their parser to read a falsy value the way we meant it.
 *
 * **`refundAddress` is required and is not decorative.** It is where the
 * deposit goes if the bill fails *after* the user has already paid — the biller
 * rejecting a top-up does not un-spend their XLM. It must be an address the
 * user actually controls, which for us is their own wallet.
 *
 * ## Manual deposit
 *
 * Linq settles at whatever amount actually arrives, converted at the locked
 * rate — "this is a manual deposit by design". So the amount we send has to be
 * the amount we quoted. An underpayment is not a failed order, it is a smaller
 * bill than the user asked for.
 *
 * Mainnet only, like everything else on this rail: Linq has no sandbox, so
 * every call moves real money. See `assertOnrampNetwork` in `./onramp`.
 */

import { LinqError, retryOnProviderFailure } from "./client";

const BASE_URL =
  process.env.LINQ_BASE_URL?.trim() ||
  "https://confidential-brianna-uselinq-52e2b233.koyeb.app";

const TIMEOUT_MS = 15_000;
const TOTAL_BUDGET_MS = 35_000;

function apiKey(): string {
  const key = process.env.LINQ_API_KEY?.trim();
  if (!key) throw new LinqError("LINQ_API_KEY is not configured", 500);
  return key;
}

type CallInit = {
  method?: string;
  body?: unknown;
  deadline?: number;
  query?: Record<string, string>;
};

/**
 * One request. Nothing here logs a request body: these carry the customer's
 * phone number and meter number, and an error handler that prints the body it
 * failed on is how personal data reaches a log aggregator.
 */
async function call<T>(path: string, init: CallInit = {}): Promise<T> {
  const { method = "GET", body, deadline, query } = init;

  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

  const remaining = deadline ? deadline - Date.now() : TIMEOUT_MS;
  if (remaining <= 0) throw new LinqError("Linq did not respond in time", 504);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(remaining, TIMEOUT_MS));

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        "X-API-Key": apiKey(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new LinqError("Linq did not respond in time", 504);
    }
    throw new LinqError("Could not reach Linq", 502);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new LinqError(
      response.ok ? "Linq returned a response we could not read" : "Linq rejected the request",
      response.ok ? 502 : response.status,
    );
  }

  if (!response.ok) {
    const message =
      (parsed as { message?: string; error?: string } | null)?.message ??
      (parsed as { message?: string; error?: string } | null)?.error ??
      "Linq rejected the request";
    throw new LinqError(message, response.status);
  }

  return parsed as T;
}

// ─── Categories ──────────────────────────────────────────────────────────────

/**
 * The bill categories this rail vends. Airtime ships first because it needs
 * only a phone number and an amount — every other category carries extra
 * fields (a data plan, a meter type) that are worth their own validation.
 */
export type BillCategory = "airtime" | "data" | "electricity" | "cabletv" | "betting";

/** The Stellar assets a bill can be funded with. */
export type BillCoin = "xlm" | "usdc";

/**
 * Linq's coin selection for bills is a bare `xlm: true` at the top level, not
 * the `coin: { … }` object the onramp uses. Omitting the key means USDC.
 *
 * Returned as a spreadable object so a caller cannot accidentally write
 * `xlm: false`, which is not how this API is told "use USDC".
 */
export function buildCoinFields(coin: BillCoin): { xlm?: true } {
  return coin === "xlm" ? { xlm: true } : {};
}

// ─── Paying a bill ───────────────────────────────────────────────────────────

export interface PayBillParams {
  customerRef: string;
  billCategory: BillCategory;
  /** The biller, e.g. `MTN` for airtime. */
  provider: string;
  /** Who the bill is for: a phone number for airtime, a meter number for electricity. */
  customerId: string;
  /** What the user is buying, in naira. */
  amountNgn: number;
  /** What that costs in the chosen asset, at {@link rate}. */
  amountStableCoin: number;
  /** NGN per unit of the asset, fetched immediately before this call. */
  rate: number;
  coin: BillCoin;
  /**
   * Where the deposit is returned if the bill fails after the user has paid.
   * Must be an address the user controls — their own wallet, never ours.
   */
  refundAddress: string;
}

export interface BillOrderResponse {
  /** Linq's order id. Needed, with the customerRef, to read status. */
  id: string;
  customerRef: string;
  /** The Stellar address the user sends the crypto to. */
  wallet: string;
  status: string;
}

/**
 * Create a bill order and get back the address to pay.
 *
 * Nothing is vended until the deposit arrives — this call only reserves the
 * order and locks the rate. The user then sends `amountStableCoin` of `coin`
 * to the returned `wallet`, and Linq vends automatically on confirmation.
 */
export async function payBill(params: PayBillParams): Promise<BillOrderResponse> {
  const {
    customerRef,
    billCategory,
    provider,
    customerId,
    amountNgn,
    amountStableCoin,
    rate,
    coin,
    refundAddress,
  } = params;

  if (!(amountNgn > 0)) {
    throw new LinqError("amountNgn must be greater than zero", 400);
  }
  if (!(amountStableCoin > 0)) {
    throw new LinqError("amountStableCoin must be greater than zero", 400);
  }
  if (!(rate > 0)) {
    throw new LinqError("rate must be greater than zero", 400);
  }
  // A missing refund address is only discovered when a bill fails, which is
  // exactly when the user's money is already gone.
  if (!refundAddress) {
    throw new LinqError("refundAddress is required", 400);
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  return retryOnProviderFailure(
    () =>
      call<BillOrderResponse>("/b2b/bills/pay", {
        method: "POST",
        deadline,
        body: {
          customerRef,
          billCategory,
          provider,
          customerId,
          amountNgn,
          amountStableCoin,
          rate,
          refundAddress,
          ...buildCoinFields(coin),
        },
      }),
    1_500,
    deadline,
  );
}

export interface BillStatus {
  orderId: string;
  customerRef: string;
  status: string;
  billCategory: string;
  amountNgn: number;
  amountStableCoin: number;
  wallet: string;
  description: string;
  created: string;
  updated: string;
}

/**
 * A bill order's status.
 *
 * Both identifiers are required, and as with the onramp an order belonging to
 * another customer is indistinguishable from one that does not exist. Keep it
 * that way: a lookup by `orderId` alone would let a guessed id confirm an
 * order exists.
 */
export function getBillStatus(customerRef: string, orderId: string): Promise<BillStatus> {
  return call<BillStatus>("/b2b/bills/status", {
    query: { customerRef, orderId },
  });
}
