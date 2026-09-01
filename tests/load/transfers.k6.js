// k6 load test for the headline transfers endpoint.
//
// Goal (SLO): sustain 1,000 RPS with p95 latency < 100 ms against a staging
// deployment.
//
// Run locally:
//   k6 run tests/load/transfers.k6.js
//
// Override the target and load shape via env vars:
//   k6 run \
//     -e BASE_URL=https://wraith-staging.example.com \
//     -e ADDRESS=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF \
//     -e RPS=1000 \
//     -e DURATION=2m \
//     tests/load/transfers.k6.js
//
// A lighter smoke run (handy on a laptop with no staging target):
//   k6 run -e RPS=20 -e DURATION=10s -e BASE_URL=http://localhost:3000 \
//     tests/load/transfers.k6.js

import http from "k6/http";
import { check } from "k6";
import { Rate } from "k6/metrics";

// ── Configuration (all overridable via -e) ───────────────────────────────────
const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

// A representative address to query. Defaults to a well-known testnet account so
// the script runs without extra config; override with -e ADDRESS=... to point
// at an account with realistic transfer volume on staging.
const ADDRESS =
  __ENV.ADDRESS ||
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const RPS = parseInt(__ENV.RPS || "1000", 10);
const DURATION = __ENV.DURATION || "2m";
const PAGE_LIMIT = parseInt(__ENV.LIMIT || "50", 10);

// Pre-allocate enough VUs to drive the target rate even if individual requests
// approach the latency budget. Allow k6 to scale up under contention.
const PRE_ALLOCATED_VUS = parseInt(__ENV.PRE_VUS || "200", 10);
const MAX_VUS = parseInt(__ENV.MAX_VUS || "1000", 10);

// ── Custom metrics ────────────────────────────────────────────────────────────
const errorRate = new Rate("errors");

// ── Options ─────────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    transfers_constant_rps: {
      executor: "constant-arrival-rate",
      rate: RPS,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  // Hard SLO gate: the run fails (non-zero exit) if these are breached.
  thresholds: {
    http_req_duration: ["p(95)<100"],
    http_req_failed: ["rate<0.01"],
    errors: ["rate<0.01"],
  },
};

// ── Test body ─────────────────────────────────────────────────────────────────
export default function () {
  const url = `${BASE_URL}/transfers/address/${ADDRESS}?limit=${PAGE_LIMIT}`;
  const res = http.get(url, {
    tags: { name: "GET /transfers/address/:address" },
  });

  const ok = check(res, {
    "status is 200": (r) => r.status === 200,
    "body has transfers array": (r) => {
      try {
        return Array.isArray(r.json("transfers"));
      } catch (_e) {
        return false;
      }
    },
  });

  errorRate.add(!ok);
}
