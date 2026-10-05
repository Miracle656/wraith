/**
 * Server-side client for Linq's **B2B-native** onramp and customer provisioning.
 *
 * This is the mirror of `client.ts`: naira in, crypto out. It closes the
 * cold-start problem that no amount of wallet code can — a brand-new Stellar
 * account needs 1 XLM of base reserve plus 0.5 XLM per trustline before it can
 * hold a single USDC, and until now the only ways to get that first XLM were
 * to already own crypto or for us to fund it.
 *
 * ## Why this file is separate from `client.ts`
 *
 * The offramp is one primitive: quote, deposit, payout. The onramp carries a
 * **customer** — a person Linq has to know about before it will take an order
 * for them — and provisioning that person means handling their identity. That
 * is a different kind of responsibility from moving an amount, so it is a
 * different file.
 *
 * ## The NIN rule, which is the whole reason to read this header
 *
 * `submitCustomerKyc` takes a National Identification Number. **It is never
 * stored, never logged, never returned, and never placed in any type that is
 * persisted.** It exists as a function argument, goes into one request body,
 * and is unreachable afterwards. There is deliberately no `nin` field on
 * {@link LinqCustomer} or {@link CustomerKycResult}, so there is nothing to
 * accidentally write to a database or an error report.
 *
 * This matters beyond tidiness: a NIN is Nigerian personal data under the NDPA,
 * and the cheapest way to hold it correctly is not to hold it. Any future change
 * that adds a NIN to a stored shape is a change in what this service legally is.
 *
 * ## Mainnet only, and the reason is user money
 *
 * Linq has no sandbox — every call here moves real naira and real crypto. A
 * Stellar `G…` address is valid on both networks, so an onramp order placed by
 * someone using the testnet build would take real naira from their bank and
 * deliver real XLM on mainnet, to an address their testnet wallet will never
 * display. They would have paid and seen nothing. {@link assertOnrampNetwork}
 * refuses that outright rather than leaving it to a caller to remember.
 */

import { LinqError, retryOnProviderFailure } from "./client";

const BASE_URL =
  process.env.LINQ_BASE_URL?.trim() ||
  "https://confidential-brianna-uselinq-52e2b233.koyeb.app";

const TIMEOUT_MS = 15_000;

/**
 * One logical operation's whole budget, retries included — the same ceiling
 * `client.ts` uses, and for the same reason: a server that answers a person
 * has to finish before their client gives up and tells them it failed.
 */
const TOTAL_BUDGET_MS = 35_000;

function apiKey(): string {
  const key = process.env.LINQ_API_KEY?.trim();
  if (!key) throw new LinqError("LINQ_API_KEY is not configured", 500);
  return key;
}

type CallInit = {
  method?: string;
  body?: unknown;
  auth?: boolean;
  deadline?: number;
  /** Query parameters, appended and encoded. */
  query?: Record<string, string>;
};

/**
 * One request. Returns typed data or throws {@link LinqError} carrying Linq's
 * own message, because their 400s name the actual problem — an unverified
 * customer, an unsupported coin — far better than anything we would invent.
 *
 * Nothing in here logs a request body. The onramp bodies carry a NIN and a
 * customer's name, email and phone; an exception handler that prints the body
 * it failed on is how personal data ends up in a log aggregator.
 */
async function call<T>(path: string, init: CallInit = {}): Promise<T> {
  const { method = "GET", body, auth = true, deadline, query } = init;

  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

  const remaining = deadline ? deadline - Date.now() : TIMEOUT_MS;
  if (remaining <= 0) {
    throw new LinqError("Linq did not respond in time", 504);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(remaining, TIMEOUT_MS));

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        ...(auth ? { "X-API-Key": apiKey() } : {}),
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
    // Not JSON. Their message is more useful than ours, but an HTML error page
    // is not a message — so send a fixed string rather than echoing a body that
    // could carry anything.
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

// ─── Network guard ───────────────────────────────────────────────────────────

/**
 * Refuse an onramp on anything but mainnet.
 *
 * Linq has no sandbox, so there is no testnet equivalent of this flow to fall
 * back to — the honest answer to "can I buy XLM with naira on testnet" is no,
 * not a simulation. Returning real funds against a testnet session would be
 * worse than refusing: the money leaves and the wallet shows nothing.
 */
export function assertOnrampNetwork(network: string): void {
  if (network !== "mainnet") {
    throw new LinqError(
      "Buying with naira is only available on mainnet. Linq has no test environment, so this would move real money against a test wallet.",
      400,
    );
  }
}

// ─── Customers ───────────────────────────────────────────────────────────────

export interface ProvisionCustomerParams {
  /**
   * Our identifier for this person, never a Linq id. The offramp already uses
   * the wallet address for this, so the same person is the same `customerRef`
   * on both sides of the rail.
   */
  customerRef: string;
  firstName: string;
  lastName: string;
  /**
   * Must be a real address: Linq forwards it to its payment provider as this
   * customer's email of record. It only has to be unique within our own
   * customers, not across all of Linq.
   */
  email: string;
  phone: string;
}

export interface LinqCustomer {
  customerRef: string;
  verified: boolean;
  /** False when the customer already existed — provisioning is idempotent. */
  created: boolean;
}

/**
 * Provision a customer. One-time per person, not per order.
 *
 * Safe to call again with the same `customerRef`: Linq returns the existing
 * customer unchanged with `created: false` rather than erroring or duplicating,
 * which means a client that retries after a dropped response cannot create two
 * customers for one person.
 */
export function provisionCustomer(params: ProvisionCustomerParams): Promise<LinqCustomer> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  return retryOnProviderFailure(
    () => call<LinqCustomer>("/b2b/customers", { method: "POST", body: params, deadline }),
    1_500,
    deadline,
  );
}

export interface CustomerKycResult {
  customerRef: string;
  verified: boolean;
  status: string;
}

/**
 * Verify a customer's identity by NIN.
 *
 * One call: Linq checks the NIN with Smile ID and marks the customer verified
 * in the same response. There is no separate OTP step to follow.
 *
 * **The `nin` argument is not stored, logged or returned by anything here.**
 * See this module's header — that is a deliberate property of the design, not
 * an incidental one, and the absence of a `nin` field on the result type is
 * what enforces it.
 *
 * Not retried. A verification attempt is rate-limited on Linq's side and may
 * have side effects with their identity provider, so a timeout here is
 * reported rather than replayed — the caller can ask the customer to try
 * again, which is honest, instead of us submitting the same identity twice.
 */
export function submitCustomerKyc(customerRef: string, nin: string): Promise<CustomerKycResult> {
  return call<CustomerKycResult>("/b2b/customers/kyc", {
    method: "POST",
    body: { customerRef, nin },
  });
}

// ─── Rate ────────────────────────────────────────────────────────────────────

/**
 * Current onramp rate, as NGN per unit of the asset the order will settle in.
 *
 * Two traps worth knowing. The endpoint returns a **bare number**, not an
 * object — unlike the offramp's `/b2b/rate` — so it is parsed defensively here.
 * And for an XLM order this is NGN-per-XLM, not NGN-per-USD: XLM floats, so a
 * rate cached even for minutes prices the order wrong. Fetch it immediately
 * before creating an order and pass that value through; never reuse one.
 */
export async function getOnrampRate(): Promise<number> {
  const value = await call<unknown>("/onramprate", { auth: false });
  const rate = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new LinqError("Linq returned an unusable onramp rate", 502);
  }
  return rate;
}

// ─── Onramp orders ───────────────────────────────────────────────────────────

/** The Stellar assets this rail settles in. */
export type OnrampCoin = "xlm" | "usdc";

export interface CreateOnrampParams {
  customerRef: string;
  /**
   * How much of the chosen asset the customer receives. Despite Linq naming the
   * field `amountStableCoin`, for an XLM order this is an amount of XLM.
   */
  amountStableCoin: number;
  /** The Stellar address the crypto is delivered to. */
  walletAddress: string;
  /** The rate from {@link getOnrampRate}, fetched immediately before this call. */
  rate: number;
  coin: OnrampCoin;
}

export interface OnrampOrderResponse {
  orderId: string;
  customerRef: string;
  /** The bank account the customer pays naira into. */
  accountNumber: string;
  bankName: string;
  accountName: string;
  amountNgn: number;
  amountStableCoin: number;
  fee: number;
  /** ISO-8601. The order is dead after this and the customer must start again. */
  expiresAt: string;
  status: string;
}

/**
 * Create an onramp order: the customer pays `amountNgn` into the returned bank
 * account, and Linq delivers the crypto to `walletAddress` on its own once the
 * deposit confirms. Nothing further is called to trigger delivery.
 *
 * `coin` maps to Linq's object form — `{ xlm: true }` for native XLM,
 * `{ stellar: true }` for USDC on Stellar. Chain selection is *not* inferred
 * from the coin name: their default is Sui, and the offramp client already
 * carries a warning that funds sent on the wrong chain are unrecoverable. The
 * mapping is therefore explicit and total, so a new coin cannot silently fall
 * through to a default.
 */
// `async` deliberately, matching `createOfframpOrder`: the guards below must
// surface as a rejection rather than a synchronous throw, so a caller that
// awaits this does not also need a try/catch wrapped around the call itself.
export async function createOnrampOrder(
  params: CreateOnrampParams,
): Promise<OnrampOrderResponse> {
  const { customerRef, amountStableCoin, walletAddress, rate, coin } = params;

  if (!(amountStableCoin > 0)) {
    throw new LinqError("amountStableCoin must be greater than zero", 400);
  }
  if (!(rate > 0)) {
    throw new LinqError("rate must be greater than zero", 400);
  }

  const coinBody: Record<string, true> =
    coin === "xlm" ? { xlm: true } : coin === "usdc" ? { stellar: true } : unsupportedCoin(coin);

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  return retryOnProviderFailure(
    () =>
      call<OnrampOrderResponse>("/b2b/onramp", {
        method: "POST",
        deadline,
        body: {
          customerRef,
          amountStableCoin,
          currency: "NGN",
          walletAddress,
          rate,
          coin: coinBody,
        },
      }),
    1_500,
    deadline,
  );
}

/** Exhaustiveness guard: a new {@link OnrampCoin} fails to compile rather than defaulting to Sui. */
function unsupportedCoin(coin: never): never {
  throw new LinqError(`Unsupported onramp coin: ${String(coin)}`, 400);
}

export interface OnrampStatus {
  orderId: string;
  customerRef: string;
  status: string;
  amount: number;
  amountNgn: number;
  bankName: string;
  accountNumber: string;
  accountName: string;
}

/**
 * An order's status.
 *
 * Both identifiers are required by Linq, and an order belonging to a different
 * customer returns the same 404 as one that does not exist — so a guessed
 * `orderId` cannot confirm an order exists. That property is worth preserving:
 * do not add a lookup that takes `orderId` alone.
 */
export function getOnrampStatus(customerRef: string, orderId: string): Promise<OnrampStatus> {
  return call<OnrampStatus>("/b2b/onramp/status", {
    query: { customerRef, orderId },
  });
}
