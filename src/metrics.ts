import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics registry.
 * All custom metrics are registered here and exposed via /metrics.
 */
export const register = new Registry();

// Enable default metrics collection (CPU, memory, heap, etc.)
collectDefaultMetrics({ register });

// ─── Custom Operational Metrics ───────────────────────────────────────────────

/**
 * Mapped to token transfers ingested.
 * Using the requested name for compatibility with existing dashboards.
 */
export const tradesIngestedTotal = new Counter({
  name: "trades_ingested_total",
  help: "Total token transfers ingested and saved to DB.",
  labelNames: ["contractId", "eventType"],
  registers: [register],
});

/**
 * Mapped to polling/ledger processing cycles.
 */
export const ammSnapshotsTotal = new Counter({
  name: "amm_snapshots_total",
  help: "Total polling cycles / batches processed.",
  registers: [register],
});

/**
 * Mapped to API request volume.
 */
export const priceRequestsTotal = new Counter({
  name: "price_requests_total",
  help: "Total REST API requests handled.",
  labelNames: ["endpoint", "status"],
  registers: [register],
});

/**
 * Placeholder for payment metrics if added in the future.
 */
export const x402PaymentsReceivedTotal = new Counter({
  name: "x402_payments_received_total",
  help: "Total payment events received.",
  registers: [register],
});

/**
 * Mapped to the timestamp of the latest ledger processed.
 */
export const lastTradeTimestamp = new Gauge({
  name: "last_trade_timestamp",
  help: "Unix timestamp of the most recently indexed transfer.",
  labelNames: ["contractId"],
  registers: [register],
});

/**
 * Duration of Postgres operations.
 */
export const dbQueryDurationSeconds = new Histogram({
  name: "db_query_duration_seconds",
  help: "Latency of database operations in seconds.",
  labelNames: ["operation"],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});
