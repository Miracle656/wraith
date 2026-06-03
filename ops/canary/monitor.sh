#!/usr/bin/env bash
# Monitor canary health and decide promote or rollback.
# Exits 0 when promotion is safe, 1 when rollback is needed.
# Usage: monitor.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MAX_ERROR_RATE="${MAX_ERROR_RATE_PCT:-5}"
MAX_LATENCY="${MAX_LATENCY_P99_MS:-2000}"
MIN_HEALTH_PCT="${MIN_HEALTH_CHECK_PCT:-95}"
CANARY_URL="${CANARY_URL:-http://localhost:3000}"
POLL_INTERVAL="${POLL_INTERVAL_SECONDS:-30}"
OBSERVATION_WINDOW="${OBSERVATION_WINDOW_SECONDS:-300}"

echo "==> [canary/monitor] window=${OBSERVATION_WINDOW}s  poll=${POLL_INTERVAL}s"
echo "    thresholds: error_rate<${MAX_ERROR_RATE}%  p99<${MAX_LATENCY}ms  health>${MIN_HEALTH_PCT}%"

healthy_checks=0
total_checks=0
elapsed=0

while [[ $elapsed -lt $OBSERVATION_WINDOW ]]; do
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
  total_checks=$((total_checks + 1))

  # ── Health check ──────────────────────────────────────────────────────────
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${CANARY_URL}/healthz" || echo "000")
  if [[ "$http_code" == "200" ]]; then
    healthy_checks=$((healthy_checks + 1))
  fi

  health_pct=$(( healthy_checks * 100 / total_checks ))
  echo "    [${elapsed}s/${OBSERVATION_WINDOW}s] healthz=${http_code}  health_pct=${health_pct}%"

  # ── Metrics probe (Prometheus-compatible) ─────────────────────────────────
  # Pull error rate from /metrics if Prometheus exposition is available.
  if metrics=$(curl -s --max-time 5 "${CANARY_URL}/metrics" 2>/dev/null); then
    error_total=$(echo "$metrics"    | grep -E '^http_requests_total\{.*status="5' | awk '{sum+=$2} END{print sum+0}')
    request_total=$(echo "$metrics"  | grep -E '^http_requests_total\{'            | awk '{sum+=$2} END{print sum+0}')
    latency_p99=$(echo "$metrics"    | grep -E '^http_request_duration_ms\{.*quantile="0.99"' | awk '{print $2+0}')

    if [[ "$request_total" -gt 0 ]]; then
      error_rate=$(( error_total * 100 / request_total ))
    else
      error_rate=0
    fi

    echo "    error_rate=${error_rate}%  p99_latency=${latency_p99}ms"

    # ── Early rollback on threshold breach ──────────────────────────────────
    if [[ "$error_rate" -gt "$MAX_ERROR_RATE" ]]; then
      echo "==> [canary/monitor] FAIL: error_rate=${error_rate}% > threshold=${MAX_ERROR_RATE}%"
      exit 1
    fi

    if [[ -n "$latency_p99" && "$latency_p99" -gt "$MAX_LATENCY" ]]; then
      echo "==> [canary/monitor] FAIL: p99_latency=${latency_p99}ms > threshold=${MAX_LATENCY}ms"
      exit 1
    fi
  fi
done

# ── Final health-rate check ────────────────────────────────────────────────
if [[ "$health_pct" -lt "$MIN_HEALTH_PCT" ]]; then
  echo "==> [canary/monitor] FAIL: health_pct=${health_pct}% < threshold=${MIN_HEALTH_PCT}%"
  exit 1
fi

echo "==> [canary/monitor] PASS: canary is healthy after ${OBSERVATION_WINDOW}s"
exit 0