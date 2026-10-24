/**
 * Counting 429s (#270).
 *
 * All Veil users share one Linq key, and it is rate limited. The retry in
 * `src/linq/http.ts` has always recognised a 429 and waited — and not one line
 * of code said how often that happened. Four manual probes during a review
 * were enough to trigger one; approaching the shared key's ceiling degrades
 * slowly and then fails everyone at once, so its 429s are now counted by
 * endpoint, separately from every other failure, with the two outcomes an
 * operator cares about kept apart: a 429 the retry absorbed is a warning, a
 * 429 the user saw is an incident.
 *
 * The provider here is the in-process fake in `../fakeLinq.ts`. Linq has no
 * sandbox and a shared real rate limit; nothing in this file reaches it.
 */
import { linqCall } from "../../linq/http";
import { renderMetrics, _resetMetrics } from "../../metrics";
import { installFakeLinq, fakeLinq } from "../fakeLinq";

process.env.LINQ_API_KEY = "biz_live_test";

/**
 * One series' value from the Prometheus exposition, or undefined when the
 * series was never observed.
 *
 * `labels` must be the metric's complete label set, so each series matches
 * exactly one line — this is what a scraper sees, not prom-client's `get()`.
 */
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

beforeEach(() => {
  _resetMetrics();
  installFakeLinq();
  // The 429 failure path logs the provider's status and body on purpose;
  // silence it so this suite's output stays readable.
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  fakeLinq.restore();
  jest.restoreAllMocks();
});

describe("provider 429s are counted by endpoint", () => {
  it("counts an absorbed 429 and a surfaced 429 as different outcomes", async () => {
    // Absorbed: the provider limits us, our retry waits, the call succeeds —
    // the caller never hears about it.
    fakeLinq.rateLimitNext("GET /onramprate", 1);
    await expect(
      linqCall<number>("/onramprate", { operation: "onramp_rate", rateLimitRetries: 1 }),
    ).resolves.toBe(1450);

    // Surfaced: a call that must not retry — a NIN submission is one — passes
    // the 429 straight on to its caller.
    fakeLinq.rateLimitNext("GET /onramprate", 1);
    await expect(
      linqCall<number>("/onramprate", { operation: "onramp_rate" }),
    ).rejects.toMatchObject({ status: 429, code: "rate_limited" });

    const text = await renderMetrics();
    const labels = { provider: "linq", operation: "onramp_rate" };
    expect(series(text, "provider_rate_limit_total", { ...labels, disposition: "absorbed" })).toBe(1);
    expect(series(text, "provider_rate_limit_total", { ...labels, disposition: "surfaced" })).toBe(1);
  });

  it("counts each endpoint's 429s separately", async () => {
    fakeLinq.rateLimitNext("GET /onramprate", 1);
    await expect(
      linqCall<number>("/onramprate", { operation: "onramp_rate" }),
    ).rejects.toMatchObject({ status: 429 });

    fakeLinq.rateLimitNext("GET /b2b/onramp/status", 1);
    await expect(
      linqCall<number>("/b2b/onramp/status", {
        operation: "onramp_status",
        query: { customerRef: "veil_test", orderId: "ord_test" },
      }),
    ).rejects.toMatchObject({ status: 429 });

    const text = await renderMetrics();
    expect(
      series(text, "provider_rate_limit_total", {
        provider: "linq",
        operation: "onramp_rate",
        disposition: "surfaced",
      }),
    ).toBe(1);
    expect(
      series(text, "provider_rate_limit_total", {
        provider: "linq",
        operation: "onramp_status",
        disposition: "surfaced",
      }),
    ).toBe(1);
  });

  it("records the wait the provider asked for, when it sends one", async () => {
    fakeLinq.rateLimitNext("GET /onramprate", 7);
    await expect(
      linqCall<number>("/onramprate", { operation: "onramp_rate" }),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 7 });

    const text = await renderMetrics();
    const labels = { provider: "linq", operation: "onramp_rate" };
    expect(series(text, "provider_rate_limit_wait_seconds_count", labels)).toBe(1);
    expect(series(text, "provider_rate_limit_wait_seconds_sum", labels)).toBe(7);
  });

  // A 429 is refused before any work is done; every other 4xx is the provider
  // refusing the request itself. Lumping them together is how the rate limit
  // hides inside "requests failed".
  it("does not count other 4xx responses as rate limits", async () => {
    fakeLinq.failNext("GET /onramprate", 400, "invalid_request", "Nope");
    await expect(
      linqCall<number>("/onramprate", { operation: "onramp_rate", rateLimitRetries: 2 }),
    ).rejects.toMatchObject({ status: 400 });

    const text = await renderMetrics();
    expect(text).not.toContain("provider_rate_limit_total{");
    expect(text).not.toContain("provider_rate_limit_wait_seconds{");
  });

  // An unbounded label makes /metrics grow until it cannot be scraped —
  // exactly when failures are piling up. The proof a scraper can see is the
  // rendered lines themselves: every label pair that may ever appear, listed.
  it("keeps the label set bounded", async () => {
    fakeLinq.rateLimitNext("GET /onramprate", 1);
    await expect(
      linqCall<number>("/onramprate", { operation: "onramp_rate" }),
    ).rejects.toMatchObject({ status: 429 });

    const labelsOf = (line: string): string[] =>
      line
        .slice(line.indexOf("{") + 1, line.lastIndexOf("}"))
        .split(",")
        .sort();

    const allowed: string[][] = [
      // The counter's one series for this 429.
      ['disposition="surfaced"', 'operation="onramp_rate"', 'provider="linq"'],
      // The wait histogram's _sum and _count carry no bucket label.
      ['operation="onramp_rate"', 'provider="linq"'],
      // …and one _bucket per finite boundary, plus +Inf.
      ...["0.5", "1", "2", "5", "10", "30", "60", "+Inf"].map((le) => [
        `le="${le}"`,
        'operation="onramp_rate"',
        'provider="linq"',
      ]),
    ];

    const lines = (await renderMetrics())
      .split("\n")
      .filter((line) => line.startsWith("provider_rate_limit"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(allowed).toContainEqual(labelsOf(line));
    }
  });
});
