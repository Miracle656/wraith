/**
 * The one HTTP client for Linq.
 *
 * Every request to the provider goes through {@link linqCall}. There used to be
 * three — in `client.ts`, `onramp.ts` and `bills.ts` — written months apart
 * against the same base URL with the same key, and they drifted in every detail
 * that matters: which fields an error was read from, whether a plain-text body
 * survived, whether a `code` was parsed at all. For a full day the KYC screen
 * could only say "rejected the request", because the copy serving it threw
 * away both halves of the provider's answer while its sibling parsed them.
 *
 * So this file owns everything that is the same for every call — the auth
 * header, the timeout and the deadline, error parsing, `code` extraction, the
 * rate-limit retry, and the failure logging — and the per-call differences are
 * arguments. A NIN check that needs thirty seconds passes `timeoutMs`; it does
 * not get a client of its own.
 *
 * ## What this never does
 *
 * **Log a request body.** These bodies carry a NIN, a customer's name, email
 * and phone, a meter number, a bank account. An error path that prints what it
 * failed on is how personal data reaches a log aggregator. Response bodies are
 * logged on failure because the provider asked for exactly that — but long
 * digit runs in them are redacted first, in case an error echoes an identifier
 * back.
 */

import {
  providerCallsTotal,
  providerRateLimitTotal,
  providerRateLimitWaitSeconds,
  providerRequestDurationSeconds,
} from "../metrics";
import { recordDependencyOutcome } from "../dependencies";

const DEFAULT_BASE_URL = "https://confidential-brianna-uselinq-52e2b233.koyeb.app";

/** Read per call, so a test or a redeploy that changes it is honoured. */
function baseUrl(): string {
  return (process.env.LINQ_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** One attempt's ceiling, unless the call says otherwise. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Everything one logical operation may spend, retries included.
 *
 * Without a shared ceiling the budgets multiplied — three 15s attempts plus
 * waits inside a call, run twice by `retryOnProviderFailure`, was about 103
 * seconds on an order creation. The clients give up after 20–40s, so users
 * were told something had failed while this server was still working on it. A
 * server that answers a person has to finish before they are told it failed,
 * so this stays below every client timeout.
 */
export const TOTAL_BUDGET_MS = 35_000;

/** The longest we will sleep on a provider 429 before trying again. */
const MAX_RETRY_DELAY_MS = 3_000;

/** A plain-text error body longer than this is a document, not a message. */
const MAX_PLAIN_MESSAGE = 200;

/** How much of a failed response body to log. */
const MAX_LOGGED_BODY = 500;

export class LinqError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * Linq's machine-readable reason, when it sent one.
     *
     * `nin_already_used`, `customer_not_verified`, `customer_not_found` and so
     * on. Carried because the alternative is what the clients did: match on
     * the prose in `message`, which silently starts mis-routing real users the
     * first time Linq rewords an error. Optional, because older responses and
     * non-JSON error bodies have none.
     */
    readonly code?: string,
    /**
     * Seconds to wait, from a `Retry-After` header on a 429.
     *
     * Read because a rate limit without a number is indistinguishable from an
     * outage: a tester hit a 429 creating an order and the screen could only
     * say "try again in a few seconds", which was a guess. The provider knows
     * the answer and sends it.
     */
    readonly retryAfterSeconds?: number,
    /**
     * The `customerRef` Linq says this person already has.
     *
     * Sent on `email_already_in_use` (and on the NIN equivalent): the identity
     * is already bound to a reference, and Linq returns which one rather than
     * only refusing. Carried because the alternative is parsing it out of the
     * prose — the message is literally
     * `This email is already registered under customerRef "veil_…"`.
     */
    readonly existingCustomerRef?: string,
  ) {
    super(message);
    this.name = "LinqError";
  }
}

/** A provider 429 carries how long we should wait before the retry. */
type RateLimited = LinqError & { retryAfterMs?: number };

/**
 * How a request failed without an HTTP answer, when it did.
 *
 * The status alone cannot say: our own abort and a provider's 504 are both
 * 504, and "unreachable" and a provider's 502 are both 502. The difference
 * decides whether a request may be sent again — a NIN check in particular
 * must not be resent after our own timeout, because the provider may still
 * be working on the one we sent. Read it with {@link linqTransport}.
 */
export type LinqTransport = "timeout" | "unreachable";
type TransportFailure = LinqError & { transport?: LinqTransport };

function withTransport(err: LinqError, transport: LinqTransport): LinqError {
  return Object.assign(err, { transport });
}

/**
 * `"timeout"` when we gave up waiting, `"unreachable"` when no connection was
 * made, and undefined when the provider answered (whatever the status).
 */
export function linqTransport(err: unknown): LinqTransport | undefined {
  return err instanceof LinqError ? (err as TransportFailure).transport : undefined;
}

/**
 * The finite vocabulary of provider operations, for the latency histogram.
 *
 * A union rather than a free string so an operation cannot silently become a
 * per-order or per-URL label — the cardinality rule that keeps /metrics
 * scrapeable. Every call site names one; there is no "other" to fall back to,
 * and adding one is a deliberate act that shows up in a review.
 */
export type LinqOperation =
  | "offramp_rate"
  | "offramp_verify_bank"
  | "offramp_trustline"
  | "offramp_order"
  | "offramp_status"
  | "onramp_customer"
  | "onramp_customer_status"
  | "onramp_kyc"
  | "onramp_rate"
  | "onramp_order"
  | "onramp_status"
  | "bill_pay"
  | "bill_status";

/** How a provider call ended, for `provider_calls_total` and latency metrics. */
export type ProviderCallOutcome = "success" | "4xx" | "5xx" | "429" | "timeout";

/**
 * Normalise a provider path into a bounded endpoint path label.
 *
 * Drops query strings (e.g. `/b2b/status?id=...` -> `/b2b/status`) and ensures
 * leading slash, so metrics labels stay strictly bounded.
 */
export function normalizeEndpointPath(path: string): string {
  const queryIndex = path.indexOf("?");
  const clean = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const withSlash = clean.startsWith("/") ? clean : `/${clean}`;

  // Collapse anything that looks like an identifier. Every Linq path today is
  // a static literal ("/b2b/onramp", "/b2b/bills/status"), so this changes
  // nothing now — it is here so that the first path carrying an order id or a
  // customer reference cannot quietly turn this label into one series per
  // request. An unbounded label does not skew /metrics, it grows it until the
  // scrape fails, which takes monitoring down at the worst possible moment.
  return withSlash
    .split("/")
    .map(segment =>
      segment.length > 0 &&
      (/^\d+$/.test(segment) || /^[0-9a-f-]{16,}$/i.test(segment) || segment.length > 24)
        ? ":id"
        : segment,
    )
    .join("/");
}

/**
 * Classify a failure into one of the bounded outcome categories:
 * - "timeout": timeout or abort
 * - "429": rate limited
 * - "4xx": client-caused 4xx error (e.g. 400 bad request)
 * - "5xx": provider-caused 5xx error or connection failure
 */
export function classifyFailureOutcome(err: unknown): "4xx" | "5xx" | "429" | "timeout" {
  if (linqTransport(err) === "timeout") return "timeout";
  if (err instanceof LinqError) {
    if (err.status === 429) return "429";
    if (err.status >= 400 && err.status < 500) return "4xx";
    if (err.status >= 500) return "5xx";
  }
  return "5xx";
}

export interface LinqCallOptions {
  /**
   * What this call is, for `provider_request_duration_seconds`. Required: a
   * default would quietly relabel an unannotated call as "other" and hide
   * exactly the operation someone forgot to classify.
   */
  operation: LinqOperation;
  method?: string;
  /** JSON-encoded when present. Never logged. */
  body?: unknown;
  /** Send `X-API-Key`. False only for the public rate endpoints. */
  auth?: boolean;
  /** Query parameters, appended and encoded. */
  query?: Record<string, string>;
  /**
   * Absolute time (ms since epoch) the whole operation must finish by,
   * retries included. Pass one to share a single budget across several calls.
   * Defaults to {@link TOTAL_BUDGET_MS} from now.
   */
  deadline?: number;
  /**
   * One attempt's ceiling. A NIN check reaches NIMC and routinely takes longer
   * than a lookup, so it raises this; it is still capped by the deadline.
   */
  timeoutMs?: number;
  /**
   * How many times a provider 429 is retried before it reaches the caller.
   *
   * A 429 is refused before any work is done, so repeating the identical
   * request cannot create anything twice — but some calls must still never be
   * replayed: an identity submission is rate-limited on Linq's side and
   * touches their identity provider. Zero unless the call opts in.
   */
  rateLimitRetries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The message for a failure whose body gave no reason a person could read.
 *
 * It says what is known and nothing more. A 4xx is the provider refusing the
 * request, so "rejected" is simply true; a 5xx is the provider failing, and
 * calling that a rejection tells the user their request was at fault — a cause
 * nobody sent. The KYC screens branch on `code`, not on this sentence, so the
 * sentence must never be the thing that implies one. The status and any code
 * ride along because they are facts, and they are what diagnoses the next one.
 * (W087)
 */
export function unexplainedFailure(status: number, code?: string): string {
  if (status >= 400 && status < 500) {
    return code ? `Linq rejected the request (${code})` : "Linq rejected the request";
  }
  const detail = code ? `HTTP ${status}, ${code}` : `HTTP ${status}`;
  return `Linq returned an error without giving a reason (${detail})`;
}

/** The first of `values` that is a non-empty string, trimmed, or undefined. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function apiKey(): string {
  const key = process.env.LINQ_API_KEY?.trim();
  if (!key) throw new LinqError("LINQ_API_KEY is not configured", 500);
  return key;
}

/**
 * `Retry-After`, in seconds, for telling a person how long to wait.
 *
 * The header is either a count of seconds or an HTTP date; both are legal and
 * both appear in the wild. A value that is neither, or is zero or in the past,
 * is no answer at all and is treated as absent — telling someone to retry
 * immediately after a rate limit is how the limit gets deeper.
 */
function retryAfterSeconds(response: Response): number | undefined {
  // `headers` is optional on purpose: a real Response always has it, but the
  // stubs in this repo's tests are plain objects, and a header lookup is not
  // worth failing a request over.
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
 * `Retry-After`, in milliseconds, for our own retry — capped.
 *
 * Unlike {@link retryAfterSeconds}, a zero counts: it is the provider telling
 * *us* the window has already reset, and sleeping a second anyway buys
 * nothing. Undefined means "not said", and the caller backs off on its own.
 */
function retryAfterWaitMs(response: Response): number | undefined {
  const raw = response.headers?.get?.("retry-after");
  if (raw == null || raw.trim() === "") return undefined;
  const asSeconds = Number(raw.trim());
  if (Number.isFinite(asSeconds)) return Math.min(Math.max(0, asSeconds) * 1_000, MAX_RETRY_DELAY_MS);
  const asDate = Date.parse(raw);
  if (!Number.isFinite(asDate)) return undefined;
  return Math.min(Math.max(0, asDate - Date.now()), MAX_RETRY_DELAY_MS);
}

/**
 * A response body made safe to log: truncated, with any run of seven or more
 * digits replaced. A NIN is eleven digits, a Nigerian phone number eleven, a
 * bank account ten, a meter number usually more — and a provider error that
 * helpfully echoes the value it rejected would otherwise put it in our logs.
 */
export function loggableBody(text: string): string {
  const trimmed = text.slice(0, MAX_LOGGED_BODY);
  return trimmed.replace(/\d{7,}/g, "[redacted]") || "(empty)";
}

/** Join the base URL and a path that may carry its own query string. */
function buildUrl(path: string, query?: Record<string, string>): URL {
  // Concatenated rather than `new URL(path, base)`, which would drop any path
  // prefix in LINQ_BASE_URL when `path` starts with a slash.
  const url = new URL(`${baseUrl()}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  return url;
}

/** One request, no retries. */
async function attempt<T>(
  path: string,
  options: LinqCallOptions,
  timeoutMs: number,
): Promise<T> {
  const { method = "GET", body, auth = true, query } = options;
  const url = buildUrl(path, query);

  // Built before the request, so a missing key is the configuration error it
  // is (500), not a network failure.
  const headers: Record<string, string> = {
    ...(auth ? { "X-API-Key": apiKey() } : {}),
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  };

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    // Logged because without it a timeout leaves no trace at all, and "no log
    // line" is indistinguishable from "the logging is not working". The
    // elapsed time says whether we gave up or the connection did.
    const waited = Date.now() - startedAt;
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`[linq] timeout after ${waited}ms calling ${path}`);
      throw withTransport(new LinqError("Linq did not respond in time", 504, "provider_timeout"), "timeout");
    }
    console.warn(
      `[linq] unreachable after ${waited}ms calling ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw withTransport(new LinqError("Could not reach Linq", 502), "unreachable");
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();

  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    if (response.ok) throw new LinqError("Linq returned a response we could not read", 502);
    // Not JSON. A short plain-text body usually *is* the reason — "Rate limit
    // exceeded, please wait", "NIN already used" — and discarding it left the
    // KYC screen with nothing to say. An HTML page is a document, not a
    // message: echoing it would put a gateway's markup on a user's screen.
    const plain = text.trim();
    console.warn(`[linq] ${response.status} from ${path}, non-JSON body: ${loggableBody(plain)}`);
    const message =
      plain && plain.length <= MAX_PLAIN_MESSAGE && !/^\s*</.test(plain)
        ? plain
        : unexplainedFailure(response.status);
    throw Object.assign(
      new LinqError(message, response.status, undefined, retryAfterSeconds(response)),
      { retryAfterMs: retryAfterWaitMs(response) },
    );
  }

  if (!response.ok) {
    // The provider asked for the status and raw body of a failure, and we had
    // neither when three testers hit an unreadable error. The REQUEST is never
    // logged — see the module header.
    console.warn(`[linq] ${response.status} from ${path} — body: ${loggableBody(text)}`);
    const body = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
    // Every key a reason has been seen under. A reason that arrives under a key
    // nobody reads is a reason the user never gets: the screen falls back to
    // guessing, and tells someone to check a name when their NIN is the problem.
    const code = firstString(body["code"], body["errorCode"], body["error_code"]);
    // The code rides in the message when there is no prose, because the prose
    // is what reaches the user, and a bare fallback leaves them a guess.
    const message =
      firstString(body["message"], body["error"], body["msg"], body["detail"], body["reason"]) ??
      unexplainedFailure(response.status, code);
    // Linq names the reference an already-registered identity belongs to.
    const existingCustomerRef = firstString(body["customerRef"], body["customer_ref"]);
    throw Object.assign(
      new LinqError(message, response.status, code, retryAfterSeconds(response), existingCustomerRef),
      { retryAfterMs: retryAfterWaitMs(response) },
    );
  }

  return parsed as T;
}

/**
 * Every request to Linq.
 *
 * Returns the parsed body, or throws {@link LinqError} carrying Linq's own
 * message, code and status — their 400s name the actual problem (a bad bank
 * code, an unverified customer) far better than anything we would invent.
 *
 * A 429 is retried only when `rateLimitRetries` says so, waiting what the
 * provider asked (or a short backoff), and never past the deadline. Every other
 * failure is the caller's to handle; see {@link retryOnProviderFailure} for the
 * one 5xx retry the order-creating calls take.
 */
export async function linqCall<T>(path: string, options: LinqCallOptions): Promise<T> {
  const deadline = options.deadline ?? Date.now() + TOTAL_BUDGET_MS;
  const perAttempt = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.rateLimitRetries ?? 0;

  // Timed around the whole operation, retries and provider-mandated waits
  // included: that is the time this request spent waiting on Linq, which is
  // what has to be comparable to its total duration. A 429 that waits two
  // seconds before succeeding is two seconds the provider cost us.
  const startedAt = process.hrtime.bigint();
  let outcome: ProviderCallOutcome = "success";

  try {
    for (let tried = 0; ; tried++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw withTransport(new LinqError("Linq did not respond in time", 504, "provider_timeout"), "timeout");
      }

      try {
        // Never wait past the deadline, even on the first attempt: a call made
        // late in a shared budget gets what is left of it, not a fresh 15s.
        return await attempt<T>(path, options, Math.min(perAttempt, remaining));
      } catch (err) {
        if (!(err instanceof LinqError) || err.status !== 429) throw err;

        // A 429 is counted the moment it arrives, before the retry decision:
        // the wait the provider asked for is a fact whether or not we can
        // honour it, and "how often does this happen" was the question nobody
        // could answer. Recorded only when the provider actually said. (#270)
        if (err.retryAfterSeconds !== undefined) {
          providerRateLimitWaitSeconds.observe(
            { provider: "linq", operation: options.operation },
            err.retryAfterSeconds,
          );
        }

        const wait =
          (err as RateLimited).retryAfterMs ?? Math.min(1_000 * (tried + 1), MAX_RETRY_DELAY_MS);
        // A wait that would end after the deadline buys nothing; surface the 429.
        if (tried >= retries || Date.now() + wait >= deadline) {
          // This 429 reached the caller — an incident, not a warning. (#270)
          providerRateLimitTotal.inc({
            provider: "linq",
            operation: options.operation,
            disposition: "surfaced",
          });
          throw err;
        }
        // Our retry is about to absorb it: the caller will never hear of this
        // 429, which makes the absorbed/surfaced split the warning/incident
        // split an operator alerts on.
        providerRateLimitTotal.inc({
          provider: "linq",
          operation: options.operation,
          disposition: "absorbed",
        });
        await sleep(wait);
      }
    }
  } catch (err) {
    outcome = classifyFailureOutcome(err);
    throw err;
  } finally {
    const endpoint = normalizeEndpointPath(path);
    providerCallsTotal.inc({ endpoint, outcome });

    // Observed on failure too. A call that spent the full 35 seconds and then
    // failed is the one an operator most needs to see, and dropping it would
    // make this histogram describe only the healthy path.
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    providerRequestDurationSeconds.observe(
      { provider: "linq", operation: options.operation, outcome },
      elapsedMs / 1000,
    );

    // The same observation `/status` reports, taken from the call that was
    // happening anyway so the status route never has to probe the provider
    // itself. Only the outcome word is kept: a Linq error message can contain
    // the request URL, and `/status` must not repeat one back.
    recordDependencyOutcome(
      "linq",
      outcome === "success",
      Math.round(elapsedMs),
      outcome === "timeout" ? "timeout" : outcome === "success" ? undefined : "error",
    );
  }
}

/**
 * One retry when the provider fails on its side: a 5xx, or no response.
 *
 * Order creation can fail transiently at the provider — "Wallet generation
 * failed" is it not managing to mint the deposit address. A 4xx is about the
 * request and is never retried.
 *
 * The retry sends the identical body. Whether that is SAFE depends on the
 * caller, not on this function, because a 5xx or a dropped connection does not
 * mean nothing was created — Linq may have done the work and lost the answer:
 *
 *  - offramp orders carry an idempotencyKey, and Linq is believed to return the
 *    original order for a key it has seen. Believed, not documented to us.
 *  - customers are keyed on customerRef, and Linq returns the existing one.
 *  - onramp orders and bills carry NO key. A retry here after a lost answer
 *    places a second, unpaid order; the caller is given the second.
 *
 * Wrap nothing new in this without deciding which of those three it is.
 *
 * `deadline` bounds the pair, so the retry cannot double the caller's budget.
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
    if (deadline !== undefined && Date.now() + delayMs >= deadline) throw err;
    await sleep(delayMs);
    return request();
  }
}
