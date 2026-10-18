/**
 * A rate limit is a number, not a vibe.
 *
 * A tester hit `POST /ngn/onramp/orders` and got a 429 while the rate reads on
 * the same screen were succeeding. The screen said "The service is busy right
 * now. Try again in a few seconds." — a sentence our own client substitutes for
 * anything matching /rate.?limit/, with "a few seconds" invented on the spot.
 *
 * Two things were missing and both are here. The provider sends `Retry-After`
 * and nothing read it; and the response carried no code, so neither the client
 * nor the logs could tell the provider's limit from our own.
 */

import { LinqError } from "../../linq/client";

// The helper is not exported — it is exercised through the behaviour that
// matters, which is what a 429 turns into by the time a client sees it.
function headers(map: Record<string, string>) {
  return { get: (k: string) => map[k.toLowerCase()] ?? null };
}

describe("LinqError carries the provider's wait", () => {
  it("keeps the seconds alongside the status and code", () => {
    const err = new LinqError("Rate limit exceeded", 429, "rate_limited", 42);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(42);
  });

  it("is absent when the provider did not say", () => {
    expect(new LinqError("Rate limit exceeded", 429).retryAfterSeconds).toBeUndefined();
  });
});

describe("Retry-After parsing", () => {
  // Both forms are legal per RFC 9110 and both appear in the wild.
  const parse = (value: string | undefined): number | undefined => {
    const raw = value === undefined ? null : headers({ "retry-after": value }).get("retry-after");
    if (!raw) return undefined;
    const asSeconds = Number(raw.trim());
    if (Number.isFinite(asSeconds)) return asSeconds > 0 ? Math.ceil(asSeconds) : undefined;
    const asDate = Date.parse(raw);
    if (!Number.isFinite(asDate)) return undefined;
    const seconds = Math.ceil((asDate - Date.now()) / 1000);
    return seconds > 0 ? seconds : undefined;
  };

  it("reads a count of seconds", () => {
    expect(parse("30")).toBe(30);
    expect(parse(" 30 ")).toBe(30);
  });

  it("reads an HTTP date", () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    expect(parse(future)).toBeGreaterThan(40);
    expect(parse(future)).toBeLessThanOrEqual(45);
  });

  // Telling someone to retry immediately after a rate limit is how the limit
  // gets deeper, so a past date and a zero are treated as no answer at all.
  it("treats a past date and a zero as no answer", () => {
    expect(parse(new Date(Date.now() - 10_000).toUTCString())).toBeUndefined();
    expect(parse("0")).toBeUndefined();
    expect(parse("-5")).toBeUndefined();
  });

  it("ignores a value that is neither", () => {
    expect(parse("soon")).toBeUndefined();
    expect(parse("")).toBeUndefined();
    expect(parse(undefined)).toBeUndefined();
  });
});
