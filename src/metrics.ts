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
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

// Standard process/Node metrics (process_cpu_seconds_total, heap sizes, event
// loop lag, …). Cheap, and they answer "is the process itself unhealthy?"
// before any of the counters below can.
collectDefaultMetrics({ register: registry });

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
 * The highest ledger the indexer has committed, per network.
 *
 * A gauge, not a counter: it is a position, and comparing it against the chain
 * tip is how lag is measured.
 */
export const lastIndexedLedger = new Gauge({
  name: "last_indexed_ledger",
  help: "Highest ledger sequence committed by the indexer, per network",
  labelNames: ["network"] as const,
  registers: [registry],
});

/**
 * Wall-clock duration of instrumented database operations.
 *
 * Buckets run from 5ms to 10s: below 5ms nothing here is worth alerting on,
 * and past 10s the request has already failed for whatever is waiting on it.
 */
export const dbQueryDurationSeconds = new Histogram({
  name: "db_query_duration_seconds",
  help: "Duration of database operations, by operation name",
  labelNames: ["operation"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * Time `fn` into {@link dbQueryDurationSeconds} under `operation`.
 *
 * Failures are timed too — a query that takes eight seconds and then throws is
 * exactly the one worth seeing, and dropping it would make the histogram
 * describe only the healthy path.
 */
export async function observeDbQuery<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const end = dbQueryDurationSeconds.startTimer({ operation });
  try {
    return await fn();
  } finally {
    end();
  }
}

/** Record one failed RPC attempt. `outcome` distinguishes a retry from a give-up. */
export function recordRpcError(outcome: "retry" | "exhausted"): void {
  rpcErrorsTotal.inc({ outcome });
}

/** Serialize the registry in Prometheus text exposition format. */
export function renderMetrics(): Promise<string> {
  return registry.metrics();
}

/** The content type Prometheus expects on a scrape response. */
export const metricsContentType = registry.contentType;

/** Test-only: clears every recorded sample without unregistering the metrics. */
export function _resetMetrics(): void {
  registry.resetMetrics();
}
