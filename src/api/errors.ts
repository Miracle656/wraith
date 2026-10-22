/**
 * One error shape for the money-moving rails (#287).
 *
 * Errors used to reach clients of `/ngn` and `/offramp` in three shapes:
 * `sendLinqError` forwarded Linq's message with a `code` only when the
 * provider happened to send one, most routes hand-wrote `{ error }`, and the
 * newer coin/idempotency refusals wrote `{ error, code }`. A client could not
 * tell whether a given failure carried a machine-readable code, yet the
 * mobile app branches on `coin_not_available` and `rate_out_of_date` — the
 * shape is the contract.
 *
 * Every failure on both rails is now written through here and answers:
 *
 * ```json
 * { "error": "human prose", "code": "stable_machine_readable_code" }
 * ```
 *
 * Rules this file exists to enforce:
 *
 *  - **`code` is always present** and never changes value — installed APKs
 *    branch on it. It is snake_case and provider-neutral. When the provider
 *    sends its own code it is passed through verbatim (never remapped); when
 *    it sends none, one of the wraith-owned fallbacks from
 *    {@link fallbackCodeFor} is assigned so the key is never absent.
 *  - **`error` is prose for a person** and never matched on; the offramp
 *    additionally scrubs the provider's name out of it
 *    ({@link withoutProviderName}), because a user-facing error is the one
 *    place the provider used to be named.
 *  - **Nothing else leaks.** Bodies are built field by field — never spread
 *    from an error object — so a stack, a connection string or a key cannot
 *    ride along. `retryAfterSeconds` is the only extra field ever added, and
 *    only alongside a provider 429.
 *
 * The full catalogue, with the meaning of each code, is documented in
 * `docs/ngn-rails.md`. A code a client cannot discover is not an API.
 */

import type { Response } from "express";
import { LinqError } from "../linq/http";
import { ORIGIN_NOT_ALLOWED } from "../middleware/cors";

/**
 * Every wraith-assigned `code` a rail can answer with.
 *
 * Excludes provider codes, which pass through verbatim and are an open set —
 * a client must default on anything outside this list. Kept here (not only in
 * the docs) so a test can assert the catalog and the documentation agree.
 *
 * | Code | Meaning |
 * | --- | --- |
 * | `not_configured` | This deployment has no provider key; the rail is off. |
 * | `invalid_request` | A required field is missing or malformed. |
 * | `invalid_coin` | `coin` is present but not one this rail prices. |
 * | `invalid_address` | Not a classic `G…` account Linq can pay to. |
 * | `invalid_network` | `?network=` names no known network. |
 * | `network_not_enabled` | A real network this deployment does not serve. |
 * | `mainnet_only` | The onramp/bills refuse to move money on testnet. |
 * | `veil_rate_limited` | Our own rate limiter refused the request. |
 * | `rate_limited` | The provider's rate limit, shared by every user. |
 * | `rate_out_of_date` | The submitted rate differs from ours beyond tolerance. |
 * | `coin_not_available` | The provider cannot source this coin right now. |
 * | `invalid_nin_format` | A NIN is not 11 digits (ours or the provider's check). |
 * | `idempotency_conflict` | The idempotency key was used for a different request. |
 * | `unauthorized` | An order access token is missing or unusable. |
 * | `order_not_found` | No such order, or the token is not its. |
 * | `provider_rejected` | The provider refused (4xx) with no usable code. |
 * | `provider_error` | The provider failed (5xx) with no usable code. |
 * | `provider_timeout` | The provider did not answer in time. |
 * | `provider_unreachable` | No connection to the provider was made. |
 * | `not_found` | No route matched (the app-wide 404). |
 * | `origin_not_allowed` | The browser's origin is not on `CORS_ALLOWED_ORIGINS` (403). |
 * | `internal_error` | An unexpected failure on our side. |
 */
export const RAIL_ERROR_CODES = [
  "not_configured",
  "invalid_request",
  "invalid_coin",
  "invalid_address",
  "invalid_network",
  "network_not_enabled",
  "mainnet_only",
  "veil_rate_limited",
  "rate_limited",
  "rate_out_of_date",
  "coin_not_available",
  "invalid_nin_format",
  "idempotency_conflict",
  "unauthorized",
  "order_not_found",
  "provider_rejected",
  "provider_error",
  "provider_timeout",
  "provider_unreachable",
  "not_found",
  ORIGIN_NOT_ALLOWED,
  "internal_error",
] as const;

export type RailErrorCode = (typeof RAIL_ERROR_CODES)[number];

/** Field order on the wire: `error` first, exactly as legacy bodies had it. */
export interface RailErrorBody {
  error: string;
  /** A catalogued wraith code, or a provider code passed through verbatim. */
  code: RailErrorCode | (string & {});
  retryAfterSeconds?: number;
}

/**
 * Write a rail error body. The only writer both rails use for their own
 * refusals, so a response cannot be assembled without a code.
 */
export function sendError(
  res: Response,
  status: number,
  /** A catalogued wraith code, or a provider code passed through verbatim. */
  code: RailErrorCode | (string & {}),
  error: string,
  /** Fields named explicitly at the call site — never a spread of an error. */
  extra?: Record<string, unknown>,
): void {
  res.status(status).json({ error, code, ...(extra ?? {}) });
}

/**
 * The payout provider is not named to users.
 *
 * Their own messages are kept, because they explain a rejected account or an
 * amount limit better than a generic line would, but with the provider's name
 * taken out: a user-facing error is the one place it still leaked.
 */
export function withoutProviderName(message: string): string {
  if (/rate.?limit|too many requests/i.test(message)) {
    return "The payout service is busy right now. Try again in a few seconds.";
  }
  if (/wallet generation failed/i.test(message)) {
    // The provider could not mint the order's deposit address: their fault,
    // transient, and meaningless to a user in its own words.
    return "The payout service couldn't set up this order. Try again in a minute.";
  }
  if (/LINQ_API_KEY/i.test(message)) return "Cash-out is not available right now";
  const replaced = message.replace(/\blinq(?:'s)?\b/gi, "the payout service");
  return replaced.charAt(0).toUpperCase() + replaced.slice(1);
}

/**
 * The code for a provider failure that carried none.
 *
 * Chosen from the status alone, because that is all we have — and the status
 * is a fact, unlike a cause nobody sent. A 429 gets `rate_limited` (the
 * provider's own limit, distinct from our `veil_rate_limited`); a 5xx is
 * `provider_error` and is answered as 502; any other 4xx is
 * `provider_rejected`. The prose says only that the request failed and how —
 * see `unexplainedFailure` in `linq/http.ts`.
 */
export function fallbackCodeFor(status: number): RailErrorCode {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_error";
  return "provider_rejected";
}

export interface SendLinqErrorOptions {
  /**
   * Scrub the provider's name out of the message first (`/offramp`) or pass
   * it through as Linq wrote it (`/ngn`). The code needs no scrubbing — it is
   * provider-neutral, which is the point of it.
   */
  scrubMessage?: boolean;
  /** The message when the failure is ours rather than Linq's. */
  fallbackMessage?: string;
}

/**
 * Map a provider failure onto the one rail error shape.
 *
 * Linq's own message still reaches the client — their 400s name the real
 * problem far better than anything we would invent — but always behind a code
 * the client can switch on, so a reworded provider message can never reroute a
 * branch. A 5xx from them is ours to own as a 502: the caller did nothing
 * wrong. A `LinqError` that sent no code gets {@link fallbackCodeFor}, never
 * a missing key.
 */
export function sendLinqError(res: Response, err: unknown, options: SendLinqErrorOptions = {}): void {
  const { scrubMessage = false, fallbackMessage = "Request failed" } = options;

  if (err instanceof LinqError) {
    const rateLimited = err.status === 429;
    if (rateLimited && err.retryAfterSeconds !== undefined) {
      res.setHeader("Retry-After", String(err.retryAfterSeconds));
    }
    const message = scrubMessage ? withoutProviderName(err.message) : err.message;
    sendError(res, err.status >= 500 ? 502 : err.status, err.code ?? fallbackCodeFor(err.status), message, {
      ...(rateLimited && err.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: err.retryAfterSeconds }
        : {}),
    });
    return;
  }

  sendError(res, 500, "internal_error", fallbackMessage);
}
