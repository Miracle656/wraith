/**
 * W079 — a NIN check that fails once must not fail for good.
 *
 * A NIN verifies once, ever, against one customer reference. On 2026-10-14 the
 * KYC endpoint returned a 5xx in ~2.2s, consistently, and with no retry every
 * user met it bare — unable to tell a provider blip from a refusal.
 *
 * These pin the four acceptance criteria:
 *  - a 500 followed by a 200 verifies, with one retry and no duplicate effect;
 *  - a 409 `nin_already_used` comes back immediately, with no retry;
 *  - the total elapsed time is bounded, not just each attempt;
 *  - the NIN is never resent to a route that has already answered.
 *
 * `global.fetch` is a stub in every test. The rails have no sandbox.
 */
import express from "express";
import request from "supertest";

jest.mock("../../linq/ngnOrders", () => ({
  recordNgnOrder: jest.fn().mockResolvedValue(undefined),
  findNgnOrder: jest.fn().mockResolvedValue(null),
}));

import {
  KYC_ATTEMPT_TIMEOUT_MS,
  KYC_BUDGET_MS,
  isRetryableKycFailure,
  submitCustomerKyc,
} from "../../linq/onramp";
import { LinqError } from "../../linq/client";
import { createNgnRouter } from "../../api/ngn";
import { networkMiddleware } from "../../middleware/network";

/** Plainly not a person's NIN; eleven digits only to pass the route's check. */
const TEST_NIN = "00000000000";
const REF = "veil_fixture_customer";

type Stub = { ok: boolean; status: number; text(): Promise<string> };
const json = (status: number, body: unknown): Stub => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const VERIFIED = json(200, { customerRef: REF, verified: true, status: "verified" });
const UNVERIFIED = json(200, { customerRef: REF, verified: false, status: "pending" });

type Answer = Stub | Error | { after: number; then: Stub } | "never";

/**
 * A provider whose KYC route and status route each answer from their own
 * script, in order (the last entry repeats). Delayed and silent answers honour
 * the abort signal, so our timeouts behave as they would against a real host.
 */
function provider(script: { kyc: Answer[]; status?: Answer[] }) {
  const queues = { kyc: [...script.kyc], status: [...(script.status ?? [UNVERIFIED])] };
  const calls: Array<{ route: "kyc" | "status"; url: string; body?: string; at: number }> = [];

  const fetchMock = jest.fn((url: unknown, init: { body?: string; signal: AbortSignal }) => {
    const route = String(url).includes("/b2b/customers/kyc") ? "kyc" : "status";
    calls.push({ route, url: String(url), body: init.body, at: Date.now() });
    const queue = queues[route];
    const answer = queue.length > 1 ? queue.shift()! : queue[0];

    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === "never" || "after" in answer) {
      return new Promise((resolve, reject) => {
        const timer =
          answer === "never" ? undefined : setTimeout(() => resolve(answer.then), answer.after);
        init.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    return Promise.resolve(answer);
  });
  global.fetch = fetchMock as never;

  return {
    calls,
    kycPosts: () => calls.filter((c) => c.route === "kyc"),
    statusChecks: () => calls.filter((c) => c.route === "status"),
  };
}

/** A connection that never got an answer, as `fetch` reports one. */
const connectionRefused = () => new TypeError("fetch failed");

beforeEach(() => {
  process.env.LINQ_API_KEY = "biz_live_test";
  process.env.NETWORKS = "testnet,mainnet";
  jest.restoreAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.useFakeTimers();
});

afterEach(() => jest.useRealTimers());

/** Run the check to completion under fake time, reporting how long it took. */
async function run(): Promise<{ result?: unknown; error?: LinqError; elapsed: number }> {
  const started = Date.now();
  let outcome: { result?: unknown; error?: LinqError } | undefined;
  submitCustomerKyc(REF, TEST_NIN).then(
    (result) => (outcome = { result }),
    (error) => (outcome = { error }),
  );
  for (let i = 0; i < 200 && !outcome; i++) await jest.advanceTimersByTimeAsync(250);
  if (!outcome) throw new Error("submitCustomerKyc never settled");
  return { ...outcome, elapsed: Date.now() - started };
}

// ─── Criterion 1 ────────────────────────────────────────────────────────────

describe("a 500 followed by a 200", () => {
  it("verifies, with exactly one retry", async () => {
    const p = provider({ kyc: [json(500, { message: "Identity provider error" }), VERIFIED] });

    const { result, error } = await run();

    expect(error).toBeUndefined();
    expect(result).toEqual({ customerRef: REF, verified: true, status: "verified" });
    expect(p.kycPosts()).toHaveLength(2);
    // One read-only question in between: did the first attempt land anyway?
    expect(p.statusChecks()).toHaveLength(1);
  });

  it("waits before resending, rather than hammering a provider that just failed", async () => {
    const p = provider({ kyc: [json(500, {}), VERIFIED] });
    await run();
    const [first, second] = p.kycPosts();
    expect(second.at - first.at).toBeGreaterThanOrEqual(1_000);
  });

  it("sends the identical body each time, and the NIN only to the KYC route", async () => {
    const p = provider({ kyc: [json(500, {}), VERIFIED] });
    await run();

    for (const post of p.kycPosts()) {
      expect(JSON.parse(post.body!)).toEqual({ customerRef: REF, nin: TEST_NIN });
    }
    for (const check of p.statusChecks()) {
      expect(check.url).not.toContain(TEST_NIN);
      expect(check.body ?? "").not.toContain(TEST_NIN);
    }
  });

  it("retries a connection that never got an answer, too", async () => {
    const p = provider({ kyc: [connectionRefused(), VERIFIED] });
    const { result } = await run();
    expect(result).toMatchObject({ verified: true });
    expect(p.kycPosts()).toHaveLength(2);
  });

  it("works through the route", async () => {
    jest.useRealTimers();
    provider({ kyc: [json(502, { code: "kyc_provider_error" }), VERIFIED] });
    const app = express();
    app.use(express.json());
    app.use(networkMiddleware);
    app.use("/ngn", createNgnRouter());

    const res = await request(app)
      .post("/ngn/customers/kyc")
      .set("x-network", "mainnet")
      .send({ customerRef: REF, nin: TEST_NIN });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ customerRef: REF, verified: true, status: "verified" });
    expect(JSON.stringify(res.body)).not.toContain(TEST_NIN);
  });
});

// ─── Criterion 4 ────────────────────────────────────────────────────────────

describe("the NIN is not resent to a route that has already answered", () => {
  // The provider verified the customer and then failed to say so. Resending
  // would be a second verification attempt for an identity already verified.
  it("asks first, and takes a verified status as the answer", async () => {
    const p = provider({ kyc: [json(500, {})], status: [VERIFIED] });

    const { result } = await run();

    expect(result).toEqual({ customerRef: REF, verified: true, status: "verified" });
    expect(p.kycPosts()).toHaveLength(1);
  });

  it("does not resend blind when the status cannot be read either", async () => {
    const p = provider({
      kyc: [json(500, { message: "Identity provider error", code: "kyc_internal_error" })],
      status: [json(503, {})],
    });

    const { error } = await run();

    // The original failure, not the status lookup's.
    expect(error).toMatchObject({ status: 500, code: "kyc_internal_error", message: "Identity provider error" });
    expect(p.kycPosts()).toHaveLength(1);
  });

  it("does not resend after our own timeout, when the first may still be in flight", async () => {
    const p = provider({ kyc: ["never"] });

    const { error, elapsed } = await run();

    expect(error).toMatchObject({ status: 504 });
    expect(p.kycPosts()).toHaveLength(1);
    expect(p.statusChecks()).toHaveLength(0);
    expect(elapsed).toBeGreaterThanOrEqual(KYC_ATTEMPT_TIMEOUT_MS);
    expect(elapsed).toBeLessThan(KYC_ATTEMPT_TIMEOUT_MS + 1_000);
  });
});

// ─── Criterion 2 ────────────────────────────────────────────────────────────

describe("an answer is never retried", () => {
  it.each([
    ["nin_already_used", 409],
    ["invalid_nin_format", 400],
    ["nin_verification_failed", 422],
  ])("%s (%i) comes back immediately, with no retry", async (code, status) => {
    const p = provider({ kyc: [json(status, { message: "No", code })] });

    const { error, elapsed } = await run();

    expect(error).toMatchObject({ status, code });
    expect(p.kycPosts()).toHaveLength(1);
    expect(p.statusChecks()).toHaveLength(0);
    // Immediately: no backoff was slept. (`run` advances in 250ms steps.)
    expect(elapsed).toBeLessThanOrEqual(250);
  });

  it("a 429 is the provider asking us to stop, and is not retried", async () => {
    const p = provider({ kyc: [json(429, { message: "Too many requests" })] });
    await run();
    expect(p.kycPosts()).toHaveLength(1);
  });
});

// ─── Criterion 3 ────────────────────────────────────────────────────────────

describe("the whole operation is bounded", () => {
  it("stays under the clients' 40s ceiling", () => {
    expect(KYC_BUDGET_MS).toBeLessThan(40_000);
    expect(KYC_ATTEMPT_TIMEOUT_MS).toBeLessThanOrEqual(KYC_BUDGET_MS);
  });

  it("gives up after three attempts against a provider that keeps failing", async () => {
    const p = provider({ kyc: [json(500, { message: "Identity provider error" })] });

    const { error, elapsed } = await run();

    expect(error).toMatchObject({ status: 500, message: "Identity provider error" });
    expect(p.kycPosts()).toHaveLength(3);
    // Backoff of 1s then 2s between them.
    expect(elapsed).toBeGreaterThanOrEqual(3_000);
    expect(elapsed).toBeLessThan(KYC_BUDGET_MS);
  });

  // The case a per-attempt timeout alone does not bound: every attempt fails
  // slowly. 12s + 1s + 12s + 2s = 27s, so the third attempt has only 8s of the
  // budget left — and is cut off there, not given a fresh thirty.
  it("cuts the last attempt off at the deadline, not at its own timeout", async () => {
    const slow500 = { after: 12_000, then: json(500, {}) };
    const p = provider({ kyc: [slow500] });

    const { error, elapsed } = await run();

    expect(error).toMatchObject({ status: 504 });
    expect(p.kycPosts()).toHaveLength(3);
    expect(elapsed).toBeGreaterThanOrEqual(KYC_BUDGET_MS - 250);
    expect(elapsed).toBeLessThanOrEqual(KYC_BUDGET_MS + 250);
  });

  it("does not start a wait that would end past the deadline", async () => {
    // Fails at 29s; the 1s wait ends at 30s, inside the budget, so it resends.
    // That fails at 33.5s, and a 2s wait would end at 35.5s — past the 35s
    // deadline, with nothing left to send a third attempt in. So it stops.
    const p = provider({
      kyc: [{ after: 29_000, then: json(500, {}) }, { after: 3_500, then: json(500, { message: "still down" }) }],
    });

    const { error, elapsed } = await run();

    expect(p.kycPosts()).toHaveLength(2);
    expect(error).toMatchObject({ status: 500, message: "still down" });
    expect(elapsed).toBeLessThan(KYC_BUDGET_MS);
  });
});

describe("isRetryableKycFailure", () => {
  const transport = (status: number, kind: string) =>
    Object.assign(new LinqError("x", status), { transport: kind });

  it.each([
    ["a provider 500", new LinqError("x", 500), true],
    ["a provider 502", new LinqError("x", 502), true],
    ["a provider 504", new LinqError("x", 504), true],
    ["no connection", transport(502, "unreachable"), true],
    ["our own timeout", transport(504, "timeout"), false],
    ["a 409", new LinqError("x", 409, "nin_already_used"), false],
    ["a 400", new LinqError("x", 400, "invalid_nin_format"), false],
    ["a 429", new LinqError("x", 429), false],
    ["something that is not a LinqError", new Error("x"), false],
  ])("%s → %p", (_what, err, expected) => {
    expect(isRetryableKycFailure(err)).toBe(expected);
  });
});
