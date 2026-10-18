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

/** The first of `values` that is a non-empty string, or undefined. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

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
  /**
   * Per-attempt ceiling, when this call is slower than most by nature.
   *
   * The default suits a lookup. A NIN check is not one: it goes out to NIMC
   * and routinely takes longer than fifteen seconds, so capping it there makes
   * us abandon an answer that was on its way.
   */
  timeoutMs?: number;
  /** Query parameters, appended and encoded. */
  query?: Record<string, string>;
};

/**
 * `Retry-After`, in seconds, when the provider sent one.
 *
 * The header is either a count of seconds or an HTTP date; both are legal and
 * both appear in the wild. A value that is neither, or is in the past, is no
 * answer at all and is treated as absent rather than as zero — telling someone
 * to retry immediately after a rate limit is how the limit gets deeper.
 */
function retryAfterSeconds(response: Response): number | undefined {
  // `headers` is optional here on purpose: a real Response always has it, but
  // the stubs in this repo's tests are plain objects, and a header lookup is
  // not worth failing a request over.
  const raw = response.headers?.get?.("retry-after");
  if (!raw) return undefined;

  const asSeconds = Number(raw.trim());
  if (Number.isFinite(asSeconds)) return asSeconds > 0 ? Math.ceil(asSeconds) : undefined;

  const asDate = Date.parse(raw);
  if (!Number.isFinite(asDate)) return undefined;
  const seconds = Math.ceil((asDate - Date.now()) / 1000);
  return seconds > 0 ? seconds : undefined;
}

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
  const { method = "GET", body, auth = true, deadline, timeoutMs, query } = init;

  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

  const remaining = deadline ? deadline - Date.now() : TIMEOUT_MS;
  if (remaining <= 0) {
    throw new LinqError("Linq did not respond in time", 504);
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(remaining, timeoutMs ?? TIMEOUT_MS));

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
    // Logged for the same reason the non-2xx path is: without it a timeout
    // leaves no trace at all, and "no log line" is indistinguishable from
    // "the logging is not working" — which is exactly the dead end we hit
    // looking for the first failure. The elapsed time is the useful part: it
    // says whether we gave up or the connection did.
    const waited = Date.now() - startedAt;
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`[linq] timeout after ${waited}ms calling ${path}`);
      throw new LinqError("Linq did not respond in time", 504);
    }
    console.warn(
      `[linq] unreachable after ${waited}ms calling ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw new LinqError("Could not reach Linq", 502);
  } finally {
    clearTimeout(timer);
  }


  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON. An HTML error page is not a message, so it is not echoed —
    // but a short plain-text body usually is the reason, and discarding it
    // left the KYC screen with nothing to say but a fixed string. Keep it when
    // it is small enough to be a message rather than a document.
    const plain = text.trim();
    if (!response.ok) {
      console.warn(
        `[linq] ${response.status} from ${path}, non-JSON body: ${plain.slice(0, 500) || "(empty)"}`,
      );
    }
    if (!response.ok && plain && plain.length <= 200 && !/^\s*</.test(plain)) {
      throw new LinqError(plain, response.status, undefined, retryAfterSeconds(response));
    }
    throw new LinqError(
      response.ok ? "Linq returned a response we could not read" : "Linq rejected the request",
      response.ok ? 502 : response.status,
    );
  }

  if (!response.ok) {
    // Logged because the provider asked for the status and raw body of a
    // failure and we had neither — three testers hit an unreadable error and
    // all we could say was that something went wrong. The REQUEST is never
    // logged: it carries the NIN, which is personal data under the NDPA and
    // is deliberately unreachable after the call. Truncated, because an error
    // body is not a place to find a bounded length.
    console.warn(
      `[linq] ${response.status} from ${path} — body: ${text.slice(0, 500) || "(empty)"}`,
    );
    const body = parsed as Record<string, unknown> | null;
    // Read the same shapes `linq/client.ts` does, plus the ones seen on these
    // routes. A reason that arrives under a key nobody reads is a reason the
    // user never gets: the KYC screen then falls back to guessing the likeliest
    // cause, and tells someone to check a name when their NIN is the problem.
    const code = firstString(body?.["code"], body?.["errorCode"], body?.["error_code"]);
    // The code rides in the message when there is no prose, because the prose
    // is what reaches the user. Three testers in a row met the bare fallback
    // "Linq rejected the request" on a NIN check, which says only that
    // something went wrong and leaves the screen to guess the cause — it
    // guessed a name mismatch each time. A code in the sentence is the
    // difference between diagnosing the next one and asking them to try again.
    const message =
      firstString(body?.["message"], body?.["error"], body?.["msg"], body?.["detail"], body?.["reason"]) ??
      (code ? `Linq rejected the request (${code})` : "Linq rejected the request");
    // Linq names the reference an already-registered identity belongs to, in a
    // `customerRef` field beside the code. Reading it is what lets
    // `provisionCustomer` adopt the existing reference instead of stranding the
    // person under a second one; the only other way to it is parsing the prose
    // `This email is already registered under customerRef "veil_…"`.
    const existingCustomerRef = firstString(body?.["customerRef"], body?.["customer_ref"]);
    throw new LinqError(
      message,
      response.status,
      code,
      retryAfterSeconds(response),
      existingCustomerRef,
    );
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
  /**
   * True when `customerRef` is **not** the one that was asked for.
   *
   * Linq refused the requested reference because this person's email is
   * already registered under a different one, and named it. The caller must
   * persist the reference in this result and use it from now on — see the note
   * on {@link provisionCustomer}.
   */
  reusedExistingRef?: boolean;
}

/**
 * Provision a customer. One-time per person, not per order.
 *
 * Safe to call again with the same `customerRef`: Linq returns the existing
 * customer unchanged with `created: false` rather than erroring or duplicating,
 * which means a client that retries after a dropped response cannot create two
 * customers for one person.
 *
 * **The reference that comes back is not always the one that went in.** An
 * email already registered under another reference is refused with
 * `email_already_in_use`, and Linq names the existing reference in the error.
 * We adopt it and return it rather than failing, because the alternative is
 * what locked testers out: the person's identity stays bound to the first
 * reference, so every later KYC and order under a second one is refused, and
 * nothing on our side could see why.
 *
 * This is the same shape as the NIN case, where an identity is already bound to
 * a reference that is not the one we are using.
 *
 * Callers **must** persist `customerRef` from the result and stop using the one
 * they sent. A reference that drifts between calls is a permanent lockout for
 * that person — `reusedExistingRef` is set so a caller can tell this happened
 * rather than having to compare strings.
 */
export async function provisionCustomer(params: ProvisionCustomerParams): Promise<LinqCustomer> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  try {
    return await retryOnProviderFailure(
      () => call<LinqCustomer>("/b2b/customers", { method: "POST", body: params, deadline }),
      1_500,
      deadline,
    );
  } catch (err) {
    const existing = err instanceof LinqError ? err.existingCustomerRef : undefined;
    // Only adopt a reference Linq actually named. Without one there is nothing
    // to fall back to, and inventing a reference is how this went wrong before.
    if (!existing) throw err;

    // Already ours and unchanged: nothing drifted, so this is the ordinary
    // idempotent case wearing an error's clothes.
    if (existing === params.customerRef) {
      return { customerRef: existing, verified: false, created: false };
    }

    // Ask Linq what state that reference is actually in rather than assuming
    // it is unverified — reporting a verified customer as unverified would send
    // them back through a rate-limited NIN check they do not need.
    const status = await getCustomerStatus(existing).catch(() => null);
    return {
      customerRef: existing,
      verified: status?.verified ?? false,
      created: false,
      reusedExistingRef: true,
    };
  }
}

export interface CustomerStatus {
  customerRef: string;
  verified: boolean;
  status?: string;
}

/**
 * Ask whether a reference is verified, without creating anything.
 *
 * Before this existed the only way to ask was `provisionCustomer`, leaning on
 * it being idempotent and reading `verified` off the reply — which works, but
 * makes creating a customer the only way to ask a question about one, and
 * needs a full set of personal details to ask it. This needs the reference
 * alone.
 *
 * It matters most for the person whose NIN is bound to a reference that is not
 * theirs any more: we can now see that the binding has moved before asking
 * them to spend a rate-limited verification attempt finding out.
 */
export function getCustomerStatus(customerRef: string): Promise<CustomerStatus> {
  return call<CustomerStatus>("/b2b/customers/status", { query: { customerRef } });
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
    // A NIN check reaches NIMC and is routinely slower than a lookup. At the
    // default fifteen seconds we were abandoning answers that were on their
    // way, and the provider's own reading of our empty error bodies is that
    // the request is timing out before their response arrives. Still inside
    // the clients' own 40s ceiling, so they never give up first.
    timeoutMs: 30_000,
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
