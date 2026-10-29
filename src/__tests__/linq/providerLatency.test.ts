/**
 * Provider latency: how much of a request wraith spent waiting on Linq.
 *
 * `http_request_duration_seconds` already says a request took twelve seconds.
 * These tests pin the other half — the provider's share — so "Linq is slow" and
 * "we are slow" are distinguishable. The provider is the in-process fake in
 * `../fakes/linqProvider.ts`, made slow on purpose with `delayNext`; nothing
 * here reaches Linq, which has no sandbox and moves real naira.
 */
import { createOfframpOrder } from "../../linq/client";
import {
  LATENCY_BUCKETS_SECONDS,
  renderMetrics,
  _resetMetrics,
} from "../../metrics";
import { installFakeLinq, type FakeLinq } from "../fakes/linqProvider";

process.env.LINQ_API_KEY = "biz_live_test";

/** Plainly fake details. None of these identify a person or a real account. */
const order = (idempotencyKey: string) => ({
  amountNGN: 1_500,
  bankAccount: "0000000000",
  bankCode: "000",
  bankName: "Fake Bank",
  accountName: "Test Person",
  idempotencyKey,
});

let linq: FakeLinq;

beforeEach(() => {
  _resetMetrics();
  linq = installFakeLinq();
  // The failing-call case logs the provider's body on purpose; silence it so
  // this suite's output stays readable.
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  expect(linq.unhandled).toEqual([]);
  linq.restore();
  jest.restoreAllMocks();
});

/**
 * One sample from the Prometheus exposition, by metric suffix and labels.
 *
 * Reading the rendered text rather than prom-client's `get()` keeps the test
 * about what a scraper actually sees.
 */
function sample(
  text: string,
  suffix: "count" | "sum",
  labels: Record<string, string>,
): number | undefined {
  const wanted = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(",");
  const line = text
    .split("\n")
    .find(
      (candidate) =>
        candidate.startsWith(`provider_request_duration_seconds_${suffix}{`) &&
        candidate.includes(wanted),
    );
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(" ") + 1));
}

const OFFRAMP_ORDER = { provider: "linq", operation: "offramp_order" } as const;

describe("provider_request_duration_seconds", () => {
  it("records time spent inside a slow provider response, not the whole call", async () => {
    linq.delayNext("/b2b/offramp", 40);

    const startedAt = process.hrtime.bigint();
    await createOfframpOrder(order("idem-slow-1"));
    const totalSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

    const text = await renderMetrics();
    const labels = { ...OFFRAMP_ORDER, outcome: "success" };

    expect(sample(text, "count", labels)).toBe(1);
    const providerSeconds = sample(text, "sum", labels)!;
    // The fake was told to take 40ms; allow for timer scheduling slack below
    // that but require the recorded provider time to reflect the delay.
    expect(providerSeconds).toBeGreaterThanOrEqual(0.03);
    // The provider's share cannot exceed the operation that contained it.
    expect(providerSeconds).toBeLessThanOrEqual(totalSeconds);
  });

  it("records a failed provider call too, so the slow failures are visible", async () => {
    linq.failNext("/b2b/offramp", {
      kind: "refuse",
      status: 400,
      body: { message: "bank code is invalid" },
    });

    await expect(createOfframpOrder(order("idem-fail-1"))).rejects.toMatchObject({ status: 400 });

    const text = await renderMetrics();
    expect(sample(text, "count", { ...OFFRAMP_ORDER, outcome: "4xx" })).toBe(1);
    expect(sample(text, "sum", { ...OFFRAMP_ORDER, outcome: "4xx" })).toBeGreaterThan(0);
  });

  it("uses buckets that cover the 35-second provider budget", () => {
    // A call that spends its whole budget must land in a finite bucket, not
    // only +Inf — the slow tail is the reason this metric exists.
    expect(LATENCY_BUCKETS_SECONDS).toEqual(expect.arrayContaining([10, 30, 35, 40]));
  });

  it("exports the 35-second bucket alongside the HTTP histogram", async () => {
    linq.delayNext("/b2b/offramp", 5);
    await createOfframpOrder(order("idem-bucket-1"));

    const text = await renderMetrics();
    expect(text).toContain("# TYPE provider_request_duration_seconds histogram");
    // The histogram that answers "how slow was Linq" and the one that answers
    // "how slow was the request" are exported from the same registry and share
    // one bucket set (LATENCY_BUCKETS_SECONDS), so they overlay directly.
    expect(text).toContain("# TYPE http_request_duration_seconds histogram");
    const bucket = text
      .split("\n")
      .find(
        (line) =>
          line.startsWith("provider_request_duration_seconds_bucket{") &&
          line.includes('operation="offramp_order"') &&
          line.includes('le="35"'),
      );
    expect(bucket).toBeDefined();
  });
});
