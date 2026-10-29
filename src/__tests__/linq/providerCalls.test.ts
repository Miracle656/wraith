/**
 * Tests for provider_calls_total and Linq call outcome metrics.
 *
 * Requirements:
 * - Counter of provider calls by endpoint path and outcome, incremented in src/linq/http.ts
 * - Every call through linqCall is counted, with no per-rail opt-in
 * - Labels are bounded: endpoint path and outcome only
 * - Outcome distinguishes: success, 4xx, 5xx, 429, timeout
 * - Latency is observed for failures as well as successes
 * - Timeout is recorded as timeout, not generic failure
 * - Tested against fake provider (never real Linq)
 */
import { linqCall, normalizeEndpointPath } from "../../linq/http";
import { renderMetrics, _resetMetrics } from "../../metrics";
import { installFakeLinq, type FakeLinq } from "../fakes/linqProvider";

process.env.LINQ_API_KEY = "biz_live_test";

let linq: FakeLinq;

beforeEach(() => {
  _resetMetrics();
  linq = installFakeLinq();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  linq.restore();
  jest.restoreAllMocks();
});

function series(
  text: string,
  metric: string,
  labels: Record<string, string>,
): number | undefined {
  const line = text.split("\n").find(
    (candidate) =>
      candidate.startsWith(`${metric}{`) &&
      Object.entries(labels).every(([key, value]) => candidate.includes(`${key}="${value}"`)),
  );
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(" ") + 1));
}

function sampleHistogram(
  text: string,
  suffix: "count" | "sum",
  labels: Record<string, string>,
): number | undefined {
  const line = text.split("\n").find(
    (candidate) =>
      candidate.startsWith(`provider_request_duration_seconds_${suffix}{`) &&
      Object.entries(labels).every(([key, value]) => candidate.includes(`${key}="${value}"`)),
  );
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(" ") + 1));
}

describe("provider_calls_total", () => {
  it("counts a successful call by endpoint path and outcome", async () => {
    await linqCall("/b2b/customers", {
      method: "POST",
      operation: "onramp_customer",
      body: { customerRef: "c_test_1" },
    });

    const text = await renderMetrics();
    expect(series(text, "provider_calls_total", { endpoint: "/b2b/customers", outcome: "success" })).toBe(1);
    expect(sampleHistogram(text, "count", { provider: "linq", operation: "onramp_customer", outcome: "success" })).toBe(1);
  });

  it("normalizes paths by stripping query parameters to preserve bounded cardinality", async () => {
    // Calling an endpoint with dynamic query parameters
    linq.failNext("/b2b/status", {
      kind: "refuse",
      status: 404,
      body: { message: "Order not found" },
    });

    await expect(
      linqCall("/b2b/status?id=ord_xyz_123&foo=bar", {
        operation: "offramp_status",
      }),
    ).rejects.toMatchObject({ status: 404 });

    const text = await renderMetrics();
    // Must be labeled by /b2b/status, not the full query string
    expect(series(text, "provider_calls_total", { endpoint: "/b2b/status", outcome: "4xx" })).toBe(1);
    expect(text).not.toContain("ord_xyz_123");
  });

  it("counts a 4xx failure as outcome 4xx", async () => {
    linq.failNext("/b2b/offramp", {
      kind: "refuse",
      status: 400,
      body: { message: "Invalid bank code" },
    });

    await expect(
      linqCall("/b2b/offramp", {
        method: "POST",
        operation: "offramp_order",
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400 });

    const text = await renderMetrics();
    expect(series(text, "provider_calls_total", { endpoint: "/b2b/offramp", outcome: "4xx" })).toBe(1);
    expect(sampleHistogram(text, "count", { provider: "linq", operation: "offramp_order", outcome: "4xx" })).toBe(1);
  });

  it("counts a 5xx failure as outcome 5xx", async () => {
    linq.failNext("/b2b/onramp", {
      kind: "refuse",
      status: 500,
      body: { message: "Internal server error" },
    });

    await expect(
      linqCall("/b2b/onramp", {
        method: "POST",
        operation: "onramp_order",
        body: {},
      }),
    ).rejects.toMatchObject({ status: 500 });

    const text = await renderMetrics();
    expect(series(text, "provider_calls_total", { endpoint: "/b2b/onramp", outcome: "5xx" })).toBe(1);
    expect(sampleHistogram(text, "count", { provider: "linq", operation: "onramp_order", outcome: "5xx" })).toBe(1);
  });

  it("counts a network drop as outcome 5xx", async () => {
    linq.failNext("/b2b/customers", {
      kind: "drop-after-work",
    });

    await expect(
      linqCall("/b2b/customers", {
        method: "POST",
        operation: "onramp_customer",
        body: { customerRef: "c_drop_1" },
      }),
    ).rejects.toMatchObject({ status: 502 });

    const text = await renderMetrics();
    expect(series(text, "provider_calls_total", { endpoint: "/b2b/customers", outcome: "5xx" })).toBe(1);
  });

  it("counts a 429 rate limit as outcome 429", async () => {
    linq.failNext("/b2b/bills/pay", {
      kind: "refuse",
      status: 429,
      body: { message: "Rate limit exceeded" },
    });

    await expect(
      linqCall("/b2b/bills/pay", {
        method: "POST",
        operation: "bill_pay",
        body: {},
      }),
    ).rejects.toMatchObject({ status: 429 });

    const text = await renderMetrics();
    expect(series(text, "provider_calls_total", { endpoint: "/b2b/bills/pay", outcome: "429" })).toBe(1);
    expect(sampleHistogram(text, "count", { provider: "linq", operation: "bill_pay", outcome: "429" })).toBe(1);
  });

  it("records a timeout as outcome timeout and records latency", async () => {
    // deadline already expired
    await expect(
      linqCall("/b2b/offramp", {
        operation: "offramp_order",
        deadline: Date.now() - 10,
      }),
    ).rejects.toMatchObject({ status: 504, code: "provider_timeout" });

    const text = await renderMetrics();
    expect(series(text, "provider_calls_total", { endpoint: "/b2b/offramp", outcome: "timeout" })).toBe(1);
    expect(sampleHistogram(text, "count", { provider: "linq", operation: "offramp_order", outcome: "timeout" })).toBe(1);
    expect(sampleHistogram(text, "sum", { provider: "linq", operation: "offramp_order", outcome: "timeout" })).toBeGreaterThanOrEqual(0);
  });

  it("asserts label names are strictly bounded to endpoint and outcome", async () => {
    await linqCall("/b2b/customers", {
      method: "POST",
      operation: "onramp_customer",
      body: { customerRef: "c_bound_test" },
    });

    const text = await renderMetrics();
    const metricLines = text.split("\n").filter((l) => l.startsWith("provider_calls_total{"));
    expect(metricLines.length).toBeGreaterThan(0);
    for (const line of metricLines) {
      expect(line).toMatch(/^provider_calls_total\{endpoint="[^"]+",outcome="(success|4xx|5xx|429|timeout)"\} \d+$/);
    }
  });
});

describe("normalizeEndpointPath", () => {
  it("leaves the static provider paths untouched", () => {
    for (const path of [
      "/b2b/onramp",
      "/b2b/onramp/status",
      "/b2b/bills/pay",
      "/b2b/customers/kyc",
      "/onramprate",
    ]) {
      expect(normalizeEndpointPath(path)).toBe(path);
    }
  });

  it("collapses identifier-shaped segments so the label stays bounded", () => {
    // No Linq path carries an id today. This is the guard for the first one
    // that does: without it, one series per order would grow /metrics until
    // the scrape fails.
    expect(normalizeEndpointPath("/b2b/onramp/status/8571")).toBe("/b2b/onramp/status/:id");
    expect(normalizeEndpointPath("/b2b/orders/3f2a9c1e4b7d8a60")).toBe("/b2b/orders/:id");
    expect(normalizeEndpointPath("/b2b/customers/veil_etn2674mxqhkabcdefgh")).toBe(
      "/b2b/customers/:id",
    );
  });

  it("still strips the query string, where references actually travel", () => {
    expect(normalizeEndpointPath("/b2b/onramp/status?customerRef=veil_abc&orderId=99")).toBe(
      "/b2b/onramp/status",
    );
  });
});
