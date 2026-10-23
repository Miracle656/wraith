/**
 * Prometheus metrics for the indexer and the API.
 *
 * Wraith runs as a persistent background service: when the indexer stalls or
 * RPC starts failing, nothing outside the logs says so. These metrics are the
 * machine-readable version of that signal — `GET /metrics` serves them in
 * Prometheus text format for scraping, dashboards, and alerting.
 *
 * Everything registers into a module-local {@link registry} rather than
 * prom-client's global default. A global register is process-wide state shared
 * with any dependency that also uses prom-client, and it cannot be cleared
 * between tests without clobbering theirs.
 *
 * Access to `GET /metrics` is restricted: see {@link metricsAccessGuard} below
 * and the README section on metrics access. Scrapers must present the bearer
 * token configured in METRICS_SCRAPE_TOKEN, and are exempt from rate limiting
 * on that basis. Anyone else receives 401/403.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { Network } from "./network";

export const registry = new Registry();

// Standard process/Node metrics (process_cpu_seconds_total, heap sizes, event
// loop lag, …). Cheap, and they answer "is the process itself unhealthy?"
// before any of the counters below can.
collectDefaultMetrics({ register: registry });

/**
 * Scrape-access gate for `GET /metrics`.
 *
 * Decision: the metrics endpoint is operational telemetry (per-rail order
 * outcomes, provider latency, failure counts). It is not public. Only holders
 * of a shared scrape bearer token may read it. The token is read from
 * METRICS_SCRAPE_TOKEN; if that variable is unset the endpoint refuses every
 * request (fail closed) rather than falling back to open access.
 *
 * The same check decides rate-limit exemption: an authorised scraper bypasses
 * the limiter (a scrape endpoint that starts 429ing goes blind exactly when it
 * is needed), while unauthorised requests never reach the handler.
 */
export function metricsScrapeTokenFromEnv(): string | undefined {
  const token = process.env.METRICS_SCRAPE_TOKEN;
  return token && token.length > 0 ? token : undefined;
}

function bearerTokenOf(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}

/** True when the request carries the configured scrape bearer token. */
export function isAuthorisedScraper(req: Request, expected = metricsScrapeTokenFromEnv()): boolean {
  if (!expected) return false;
  const presented = bearerTokenOf(req);
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Express middleware guarding `GET /metrics`.
 *
 * 503 when no scrape token is configured (the endpoint is disabled, not open);
 * 401 when no credentials are presented; 403 when the presented token is wrong.
 */
export function metricsAccessGuard(req: Request, res: Response, next: NextFunction): void {
  const expected = metricsScrapeTokenFromEnv();
  if (!expected) {
    res.status(503).json({ error: "metrics endpoint is not configured" });
    return;
  }
  if (!bearerTokenOf(req)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="metrics"');
    res.status(401).json({ error: "authentication required" });
    return;
  }
  if (!isAuthorisedScraper(req, expected)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}

/**
 * HTTP request count by method, route pattern, and status code.
 *
 * The route label uses the Express route pattern (e.g. /transfers/incoming/:address),
 * never the raw path — addresses and other dynamic values must not become label values.
 * /metrics is excluded from its own counters.
 */
export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests by method, route pattern, and status code",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

/**
 * Histogram buckets for request and provider latency, in seconds.
 *
 * The naira rails budget 35 seconds for a whole provider operation
 * (`TOTAL_BUDGET_MS` in src/linq/http.ts), retries and waits included. Buckets
 * therefore run past that to 40s: a call that spends its entire budget must
 * land in a finite bucket, not only `+Inf`, or the slow tail — exactly the
 * requests this metric exists for — is invisible.
 *
 * Shared by {@link httpRequestDurationSeconds} and
 * {@link providerRequestDurationSeconds} so a dashboard can overlay them
 * directly: same unit, same boundaries.
 */
export const LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 20, 25, 30, 35, 40,
];

/**
 * HTTP request latency by method and route pattern.
 *
 * The route label uses the Express route pattern, never the raw path.
 * /metrics is excluded from its own histogram.
 */
export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds, by method and route pattern",
  labelNames: ["method", "route"] as const,
  buckets: LATENCY_BUCKETS_SECONDS,
  registers: [registry],
});

/**
 * Time spent inside a payment-provider call, separately from the request.
 *
 * `http_request_duration_seconds` says a request took twelve seconds; this
 * says how many of them were Linq. Same unit and bucket boundaries, so a
 * dashboard can compare the two directly — and, per route, the difference is
 * the time wraith spent itself:
 *
 *   sum by (route) (rate(http_request_duration_seconds_sum[5m]))
 *     - sum by (operation) (rate(provider_request_duration_seconds_sum[5m]))
 *
 * Labels are a fixed vocabulary: `provider` is "linq", `operation` is a
 * `LinqOperation` constant from src/linq/http.ts ("offramp_order",
 * "bill_pay", …) and `outcome` is success/error/timeout. Never a path, an order id, a customer
 * reference or a provider message — an unbounded label makes /metrics grow
 * until it cannot be scraped, exactly when failures are piling up.
 */
export const providerRequestDurationSeconds = new Histogram({
  name: "provider_request_duration_seconds",
  help: "Time spent inside payment-provider calls, by provider, operation and outcome",
  labelNames: ["provider", "operation", "outcome"] as const,
  buckets: LATENCY_BUCKETS_SECONDS,
  registers: [registry],
});

/**
 * Ledgers the indexer has advanced through, per network.
 *
 * The rate of this is the alert that matters: a flat
 * `rate(ledgers_indexed_total[5m])` on a network whose loop is supposed to be
 * running means the indexer has stalled, whether or not the process is alive.
 */
export const ledgersIndexedTotal = new Counter({
  name: "ledgers_indexed_total",
  help: "Ledgers advanced through by the indexer, per network",
  labelNames: ["network"] as const,
  registers: [registry],
});

/**
 * Rows written by the indexer, split by record type.
 *
 * `type` separates fungible transfers from NFT ones: they come off different
 * parse paths and one can break while the other keeps working.
 */
export const transfersStoredTotal = new Counter({
  name: "transfers_stored_total",
  help: "Transfer records persisted by the indexer, per network and record type",
  labelNames: ["network", "type"] as const,
  registers: [registry],
});

/**
 * Failed RPC attempts, counted per attempt rather than per call.
 *
 * `withRetry` hides transient failures from callers by design, so counting only
 * calls that exhausted their retries would report zero right up until the
 * moment the indexer falls over. Counting attempts surfaces a degrading
 * endpoint while it is still succeeding.
 */
export const rpcErrorsTotal = new Counter({
  name: "rpc_errors_total",
  help: "Failed RPC attempts (each retry counts separately)",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

/**
 * Ledgers the indexer gave up on, per network.
 *
 * A skip is the one failure the indexer cannot recover from: the ledger's events
 * are never written and the cursor has already advanced past it, so the gap is
 * permanent. It only happens for a genuine XDR decode failure, which means any
 * non-zero value deserves a look, and a `rate()` over it says whether the gap is
 * still growing.
 *
 * Labelled by network only. The ledger number would be the interesting value and
 * is deliberately absent: one series per skipped ledger is unbounded cardinality,
 * and the counter answers the same question without it.
 */
export const ledgersSkippedTotal = new Counter({
  name: "ledgers_skipped_total",
  help: "Ledgers skipped by the indexer after an XDR decode failure, per network",
  labelNames: ["network"] as const,
  registers: [registry],
});

/**
 * Events dropped by the decoder, by reason.
 *
 * `malformed` means a token event that failed to decode; a rising rate points
 * at a contract emitting non-standard events or a decoder bug.
 */
export const eventsSkippedTotal = new Counter({
  name: "events_skipped_total",
  help: "Events skipped by the decoder",
  labelNames: ["reason"] as const,
  registers: [registry],
});

/** The money-moving rails, as a finite label set. */
export type OrderRail = "offramp" | "onramp" | "bills";

/** Terminal endings the provider uses, normalised to one word each. */
export type OrderTerminalStatus =
  | "completed"
  | "settled"
  | "disbursed"
  | "failed"
  | "expired"
  | "cancelled"
  | "refunded"
  | "reversed"
  | "timeout";

/**
 * Segments that mean the order is still moving, whatever ending-word appears
 * beside them. Checked before the endings below because those are substring
 * matches: "refund_pending" contains "refund".
 */
const STILL_MOVING_SEGMENTS = [
  "pending",
  "processing",
  "awaiting",
  "queued",
  "initiated",
  "progress",
  "not",
];

/**
 * Map any provider or webhook status to a bounded terminal status, or null.
 *
 * Statuses arrive from several places and are not one vocabulary: a webhook
 * says `order.completed`, a poll may say `settled`, and the provider can
 * expire, cancel, refund or reverse an order. The metric label must be drawn
 * from a finite set, so every spelling of an ending maps to one of the words
 * below. Anything still in flight, or an ending nobody has taught us yet,
 * returns null and is not counted as terminal.
 */
export function terminalStatusOf(status: string | null | undefined): OrderTerminalStatus | null {
  if (!status) return null;
  const s = status.toLowerCase();

  // Reading a pending status as an ending does more than inflate the counter:
  // the caller only records a transition when the previous status was not
  // terminal, so once "refund_pending" counts as refunded, the actual refund is
  // never counted at all.
  const segments = s.split(/[^a-z]+/).filter(Boolean);
  if (segments.some((segment) => STILL_MOVING_SEGMENTS.includes(segment))) return null;

  if (s.includes("completed")) return "completed";
  if (s.includes("settled")) return "settled";
  if (s.includes("disbursed")) return "disbursed";
  if (s.includes("failed")) return "failed";
  if (s.includes("expire")) return "expired";
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("refund")) return "refunded";
  if (s.includes("revers")) return "reversed";
  if (s.includes("timeout")) return "timeout";
  return null;
}

/**
 * Orders created successfully, by rail.
 *
 * Counted only after the provider has returned an order (and, on the offramp,
 * after our row is written), so a retry that replays an existing order does
 * not inflate the number.
 */
export const ordersCreatedTotal = new Counter({
  name: "orders_created_total",
  help: "Orders created successfully, by rail",
  labelNames: ["rail"] as const,
  registers: [registry],
});
