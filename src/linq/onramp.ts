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

import { LinqError, linqCall, linqTransport, retryOnProviderFailure, TOTAL_BUDGET_MS } from "./http";

export { unexplainedFailure } from "./http";

/**
 * Every onramp and customer request goes through the shared client in
 * `./http`, which owns auth, timeouts, error parsing and logging. Nothing here
 * opts into the 429 retry: a NIN submission in particular must never be
 * replayed, and the order-creating calls take `retryOnProviderFailure` instead.
 */
const call = linqCall;

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
  /**
   * False when the customer already existed at the moment Linq answered —
   * provisioning is idempotent. Not "this request created nothing": see
   * {@link provisionCustomer} on dropped responses.
   */
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
 * customers for one person. That rests on Linq's behaviour, which the fake
 * provider encodes and `__tests__/linq/idempotency.test.ts` holds us to.
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
 *
 * Two further things it does NOT promise:
 *  - The details you sent are stored. The key is the reference alone, and an
 *    existing customer comes back *unchanged* — provisioning again with a
 *    corrected email or phone silently keeps the old one.
 *  - `created` says whether *this call* created them. After a dropped response
 *    the internal retry finds the customer the first attempt made, and answers
 *    `created: false` for a person who did not exist a second earlier.
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
 * The whole NIN check's budget, retries, waits and status checks included.
 *
 * Under the clients' own 40s ceiling with room to spare, so a person is never
 * told the check failed while this server is still running it — and the same
 * figure every other provider operation here is held to.
 */
export const KYC_BUDGET_MS = TOTAL_BUDGET_MS;

/**
 * One attempt's ceiling. A NIN check reaches NIMC and is routinely slower than
 * a lookup: at fifteen seconds we were abandoning answers that were on their
 * way. Each attempt still gets only what is left of {@link KYC_BUDGET_MS}.
 */
export const KYC_ATTEMPT_TIMEOUT_MS = 30_000;

/** Attempts in all, so at most two retries. */
const KYC_MAX_ATTEMPTS = 3;

/** Wait before the n-th retry (1-based): 1s, then 2s. */
const kycBackoffMs = (retry: number) => 1_000 * retry;

/**
 * May a failed NIN submission be sent again?
 *
 * **Yes** for a provider 5xx — it answered, and the answer was that it failed
 * (on 2026-10-14 the endpoint returned a 5xx in ~2.2s, consistently) — and for
 * a connection that never got an answer.
 *
 * **Never** for a 4xx. `nin_already_used` and `invalid_nin_format` are answers,
 * not failures, and a 429 is the provider telling us to stop; each retry would
 * spend an attempt against a rate-limited provider and change nothing.
 *
 * **Not** for our own timeout. The provider may still be working on the NIN we
 * sent, so sending it again is exactly the duplicate attempt this must never
 * make. The person is told it timed out, which is true.
 */
export function isRetryableKycFailure(err: unknown): boolean {
  if (!(err instanceof LinqError)) return false;
  const transport = linqTransport(err);
  if (transport === "timeout") return false;
  if (transport === "unreachable") return true;
  return err.status >= 500;
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
 * ## Retries
 *
 * A NIN verifies once, ever, against one customer reference, and a person who
 * meets a provider blip cannot tell it from a refusal. So a provider failure
 * is retried — see {@link isRetryableKycFailure} for exactly which — with a
 * short backoff, inside {@link KYC_BUDGET_MS} for the whole operation.
 *
 * **The NIN is never resent to a route that has already answered.** A failure
 * can hide a success: the provider may have verified the customer and then
 * failed to tell us. Before any resend we ask `GET /b2b/customers/status`,
 * which takes the reference alone. Verified already → that is the answer, and
 * the NIN does not travel again. If even that question cannot be answered, we
 * do not resend blind; the original failure is reported.
 */
export async function submitCustomerKyc(
  customerRef: string,
  nin: string,
): Promise<CustomerKycResult> {
  const deadline = Date.now() + KYC_BUDGET_MS;
  const submit = () =>
    call<CustomerKycResult>("/b2b/customers/kyc", {
      method: "POST",
      body: { customerRef, nin },
      deadline,
      timeoutMs: KYC_ATTEMPT_TIMEOUT_MS,
    });

  for (let attempt = 1; ; attempt++) {
    try {
      return await submit();
    } catch (err) {
      if (!isRetryableKycFailure(err) || attempt >= KYC_MAX_ATTEMPTS) throw err;

      // Did the attempt that "failed" land anyway? Asked before any wait, so a
      // verification that went through is reported as soon as we can see it.
      let status: CustomerStatus;
      try {
        status = await call<CustomerStatus>("/b2b/customers/status", {
          query: { customerRef },
          deadline,
        });
      } catch {
        throw err;
      }
      if (status.verified) {
        return { customerRef, verified: true, status: status.status ?? "verified" };
      }

      // A wait that ends at or past the deadline leaves nothing to send in.
      const wait = kycBackoffMs(attempt);
      if (Date.now() + wait >= deadline) throw err;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
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
 *
 * **Not idempotent.** No key is sent and Linq documents none, yet this is
 * retried on a 5xx or a dropped connection — so a retry after Linq created the
 * order and lost the answer places a second one, and the customer is shown the
 * second. That is tolerable only because creating an order moves no money: the
 * orphan has no deposit and lapses at `expiresAt`. A client that resubmits
 * gets a second order the same way. Pinned in `__tests__/linq/idempotency.test.ts`;
 * see docs/idempotency.md before adding a key or removing the retry.
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
