/**
 * W078 — one HTTP client for Linq.
 *
 * `client.ts`, `onramp.ts` and `bills.ts` each had their own `call()` against
 * the same provider, and they drifted: one parsed `code` and kept a plain-text
 * error body, one threw both away, one read only `message` and `error`. For a
 * day the KYC screen could only say "rejected the request" because of it.
 *
 * The existing suites in this directory pin each rail's error shapes and pass
 * untouched. These pin what only a single client can promise:
 *
 *  - exactly one implementation reaches the provider;
 *  - every provider call, on every rail, carries the provider's `code`;
 *  - every API route forwards that `code` to its caller;
 *  - a short plain-text body survives, and an HTML page does not — everywhere;
 *  - the per-call differences (timeout, 429 retry) are arguments that work.
 *
 * `global.fetch` is a stub in every test. The naira rails have no sandbox.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, sep } from "path";
import express from "express";
import request from "supertest";

jest.mock("../../db", () => ({
  prisma: {
    offrampOrder: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));
jest.mock("../../linq/ngnOrders", () => ({
  recordNgnOrder: jest.fn().mockResolvedValue(undefined),
  findNgnOrder: jest.fn().mockResolvedValue(null),
}));

import { LinqError, linqCall, loggableBody } from "../../linq/http";
import * as client from "../../linq/client";
import * as onramp from "../../linq/onramp";
import * as bills from "../../linq/bills";
import { createNgnRouter, __clearNgnRateCache } from "../../api/ngn";
import { __clearCoinPriceCache } from "../../linq/coinPrice";
import { createOfframpRouter } from "../../api/offramp";
import { networkMiddleware } from "../../middleware/network";

const G = "GBUO4RL4RTGRFSUDUMRFMC75EWYCRTX5OE3PBIXJVDCZULOXQ2TKDR4Z";
/** Plainly not a person's NIN; eleven digits only to pass the shape check. */
const TEST_NIN = "00000000000";

type Stub = { ok: boolean; status: number; headers?: { get(k: string): string | null }; text(): Promise<string> };

const reply = (status: number, body: string, headers: Record<string, string> = {}): Stub => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});
const json = (status: number, body: unknown) => reply(status, JSON.stringify(body));

/**
 * Horizon's order book, which `usdPerCoin('xlm')` reads to price XLM.
 *
 * It calls `res.json()` rather than `res.text()`, so this carries its own
 * `json()`. The onramp used to be exercised with `usdc` — a dollar by
 * construction, needing no book — but it now refuses USDC because Linq
 * cannot source it, so the XLM path is the only one left to test with.
 */
const orderBook = () => ({
  ...reply(200, "{}"),
  json: async () => ({ bids: [{ price: "0.2" }], asks: [{ price: "0.2" }] }),
});

/** Every fetch answers with `stub`. */
function provider(stub: Stub | ((url: string) => Stub)): jest.Mock {
  const mock = jest.fn(async (url: unknown) => (typeof stub === "function" ? stub(String(url)) : stub));
  global.fetch = mock as never;
  return mock;
}

beforeEach(() => {
  process.env.LINQ_API_KEY = "biz_live_test";
  process.env.NETWORKS = "testnet,mainnet";
  delete process.env.LINQ_BASE_URL;
  jest.restoreAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  __clearNgnRateCache();
  // The onramp now prices XLM from an order book and caches the result at
  // module scope. Without this, a price cached here leaks into later suites.
  __clearCoinPriceCache();
});

// ─── One implementation ─────────────────────────────────────────────────────

describe("exactly one client reaches the provider", () => {
  const SRC = join(__dirname, "../..");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
      return /\.ts$/.test(name) ? [full] : [];
    });
  }

  const files = sourceFiles(SRC).map((path) => ({
    // Normalise to forward slashes: `join` uses the platform separator, so on
    // Windows every path below arrived as `linq\http.ts` and compared unequal
    // to the `linq/http.ts` these assertions are written against. The guard was
    // satisfied; only the separator differed, so this failed on a Windows
    // checkout and passed on CI — the worst way for a test to be wrong.
    path: path.slice(SRC.length + 1).split(sep).join("/"),
    text: readFileSync(path, "utf8"),
  }));

  // The three things that make a request *to Linq*: its base URL, its host,
  // and its auth header. Only the shared client may hold any of them.
  it.each([
    ["the LINQ_BASE_URL variable", /LINQ_BASE_URL/],
    ["the provider's host", /uselinq/],
    ["the X-API-Key header", /X-API-Key/],
  ])("only http.ts names %s", (_what, pattern) => {
    const holders = files.filter((f) => pattern.test(f.text)).map((f) => f.path);
    expect(holders).toEqual(["linq/http.ts"]);
  });

  it("has no other call() or fetch() in the Linq modules but Horizon's price feed", () => {
    const linq = files.filter((f) => f.path.startsWith("linq/") && f.path !== "linq/http.ts");
    for (const f of linq) expect(f.text).not.toMatch(/async function call\b/);
    const fetching = linq.filter((f) => /\bfetch\(/.test(f.text)).map((f) => f.path);
    // coinPrice reads Horizon's order book, not Linq.
    expect(fetching).toEqual(["linq/coinPrice.ts"]);
  });
});

// ─── Every provider call carries `code` ─────────────────────────────────────

describe("every provider call carries the provider's code", () => {
  const order = { customerRef: "veil_x", amountStableCoin: 10, walletAddress: G, rate: 1500, coin: "usdc" as const };
  const bill = {
    customerRef: "veil_x",
    billCategory: "airtime" as const,
    provider: "MTN",
    customerId: "08000000000",
    amountNgn: 1000,
    amountStableCoin: 0.66,
    rate: 1500,
    coin: "usdc" as const,
    refundAddress: G,
  };
  const offramp = {
    amountNGN: 2000,
    bankAccount: "0000000000",
    bankCode: "058",
    bankName: "Test",
    accountName: "Test Person",
    idempotencyKey: "k",
  };

  const CALLS: Array<[string, () => Promise<unknown>]> = [
    ["client.getRate", () => client.getRate()],
    ["client.verifyBank", () => client.verifyBank("058", "0000000000")],
    ["client.checkStellarTrustline", () => client.checkStellarTrustline(G)],
    ["client.createOfframpOrder", () => client.createOfframpOrder(offramp)],
    ["client.getOfframpStatus", () => client.getOfframpStatus("ord_1")],
    ["onramp.provisionCustomer", () => onramp.provisionCustomer({ customerRef: "veil_x", firstName: "A", lastName: "B", email: "a@example.com", phone: "08000000000" })],
    ["onramp.getCustomerStatus", () => onramp.getCustomerStatus("veil_x")],
    ["onramp.submitCustomerKyc", () => onramp.submitCustomerKyc("veil_x", TEST_NIN)],
    ["onramp.getOnrampRate", () => onramp.getOnrampRate()],
    ["onramp.createOnrampOrder", () => onramp.createOnrampOrder(order)],
    ["onramp.getOnrampStatus", () => onramp.getOnrampStatus("veil_x", "ord_1")],
    ["bills.payBill", () => bills.payBill(bill)],
    ["bills.getBillStatus", () => bills.getBillStatus("veil_x", "ord_1")],
  ];

  it.each(CALLS)("%s", async (_name, run) => {
    provider(json(409, { message: "Refused", code: "provider_said_no" }));
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(LinqError);
    expect(err).toMatchObject({ status: 409, code: "provider_said_no", message: "Refused" });
  });

  // `client.ts` read only `code`; `bills.ts` read none. Now every rail reads
  // every key the provider has been seen to use.
  it.each(["code", "errorCode", "error_code"])("reads it from `%s` on every rail", async (key) => {
    for (const run of [() => client.getRate(), () => onramp.getCustomerStatus("r"), () => bills.getBillStatus("r", "o")]) {
      provider(json(409, { [key]: "provider_said_no" }));
      await expect(run()).rejects.toMatchObject({ code: "provider_said_no" });
    }
  });
});

// ─── Every route forwards `code` ────────────────────────────────────────────

describe("every API route forwards the provider's code", () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(networkMiddleware);
    app.use("/ngn", createNgnRouter());
    app.use("/offramp", createOfframpRouter());
    return app;
  }

  /**
   * Refuse everything with a code — except the onramp rate, which the order
   * routes check before placing an order, so the refusal reaches the call
   * under test rather than the price check in front of it.
   */
  const refuseAllBut = (allowRate: boolean) =>
    provider((url) =>
      // The onramp prices XLM from a Horizon order book, which is not the
      // provider and must not be refused here — otherwise the 409 under test
      // is masked by a price lookup failing in front of it. (The onramp used
      // to be exercised with `usdc`, which needs no book at all; it now
      // refuses USDC because Linq cannot source it.)
      url.includes("/order_book")
        ? orderBook()
        : allowRate && url.includes("/onramprate")
          ? reply(200, "1500")
          : json(409, { message: "Refused", code: "provider_said_no" }),
    );

  const ROUTES: Array<[string, (app: express.Express) => request.Test, boolean]> = [
    ["POST /ngn/customers", (a) => request(a).post("/ngn/customers").send({ customerRef: "r", firstName: "A", lastName: "B", email: "a@example.com", phone: "0800" }), false],
    ["GET /ngn/customers/status", (a) => request(a).get("/ngn/customers/status?customerRef=r"), false],
    ["POST /ngn/customers/kyc", (a) => request(a).post("/ngn/customers/kyc").send({ customerRef: "r", nin: TEST_NIN }), false],
    ["GET /ngn/onramp/rate", (a) => request(a).get("/ngn/onramp/rate?coin=xlm"), false],
    ["POST /ngn/onramp/orders", (a) => request(a).post("/ngn/onramp/orders").send({ customerRef: "r", amountStableCoin: 10, walletAddress: G, rate: 300, coin: "xlm" }), true],
    ["GET /ngn/onramp/orders/:id", (a) => request(a).get("/ngn/onramp/orders/ord_1?customerRef=r"), false],
    ["POST /ngn/bills", (a) => request(a).post("/ngn/bills").send({ customerRef: "r", billCategory: "airtime", provider: "MTN", customerId: "0800", amountNgn: 1000, amountStableCoin: 0.66, rate: 1500, coin: "usdc", refundAddress: G }), true],
    ["GET /ngn/bills/:id", (a) => request(a).get("/ngn/bills/ord_1?customerRef=r"), false],
    ["GET /offramp/rate", (a) => request(a).get("/offramp/rate"), false],
    ["POST /offramp/verify-bank", (a) => request(a).post("/offramp/verify-bank").send({ bankCode: "058", accountNumber: "0000000000" }), false],
    ["GET /offramp/trustline", (a) => request(a).get(`/offramp/trustline?address=${G}`), false],
    ["POST /offramp/orders", (a) => request(a).post("/offramp/orders").send({ amountStableCoin: 50, bankAccount: "0000000000", bankCode: "058", bankName: "Test", accountName: "Test Person", walletAddress: G, idempotencyKey: "k1" }), false],
  ];

  it.each(ROUTES)("%s", async (_name, send, allowRate) => {
    const stub = refuseAllBut(allowRate);
    const res = await send(makeApp()).set("x-network", "mainnet");
    expect(stub).toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("provider_said_no");
    expect(res.body.error).toBe("Refused");
  });
});

// ─── Plain text survives; HTML does not — on every rail ─────────────────────

describe("non-JSON error bodies, the same on every rail", () => {
  const RAILS: Array<[string, () => Promise<unknown>]> = [
    ["client", () => client.verifyBank("058", "0000000000")],
    ["onramp", () => onramp.getCustomerStatus("veil_x")],
    ["bills", () => bills.getBillStatus("veil_x", "ord_1")],
  ];

  it.each(RAILS)("%s keeps a short plain-text reason, with its status", async (_rail, run) => {
    provider(reply(409, "NIN already used"));
    await expect(run()).rejects.toMatchObject({ status: 409, message: "NIN already used" });
  });

  // `client.ts` used to echo any non-JSON body, markup included.
  it.each(RAILS)("%s refuses to echo an HTML error page", async (_rail, run) => {
    provider(reply(502, "<html><body><h1>502 Bad Gateway</h1></body></html>"));
    const err = (await run().catch((e: unknown) => e)) as LinqError;
    expect(err.status).toBe(502);
    // A gateway failure is not the request being rejected (W087).
    expect(err.message).toBe("Linq returned an error without giving a reason (HTTP 502)");
    expect(err.message).not.toContain("<");
  });

  it.each(RAILS)("%s refuses a plain-text body too long to be a message", async (_rail, run) => {
    provider(reply(500, "x".repeat(201)));
    await expect(run()).rejects.toMatchObject({
      message: "Linq returned an error without giving a reason (HTTP 500)",
    });
  });
});

// ─── Per-call differences are arguments ─────────────────────────────────────

describe("per-call options", () => {
  it("retries a 429 only when the call opts in", async () => {
    const limited = reply(429, "Rate limit exceeded", { "retry-after": "0" });

    let stub = provider(limited);
    await expect(linqCall("/x")).rejects.toMatchObject({ status: 429 });
    expect(stub).toHaveBeenCalledTimes(1);

    stub = provider(limited);
    await expect(linqCall("/x", { rateLimitRetries: 2 })).rejects.toMatchObject({ status: 429 });
    expect(stub).toHaveBeenCalledTimes(3);
  });

  it("keeps the offramp's 429 retry, and never retries a NIN submission", async () => {
    let stub = provider(reply(429, "slow down", { "retry-after": "0" }));
    await expect(client.getRate()).rejects.toMatchObject({ status: 429 });
    expect(stub).toHaveBeenCalledTimes(3);

    stub = provider(reply(429, "slow down", { "retry-after": "0" }));
    await expect(onramp.submitCustomerKyc("veil_x", TEST_NIN)).rejects.toMatchObject({ status: 429 });
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("reports the provider's wait on every rail", async () => {
    provider(reply(429, JSON.stringify({ message: "slow" }), { "retry-after": "7" }));
    await expect(bills.getBillStatus("r", "o")).rejects.toMatchObject({ retryAfterSeconds: 7 });
  });

  describe("timeouts", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    /** A provider that never answers, but honours the abort signal. */
    function silentProvider() {
      global.fetch = jest.fn(
        (_url: unknown, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ) as never;
    }

    it("gives an ordinary call fifteen seconds", async () => {
      silentProvider();
      const pending = onramp.getCustomerStatus("veil_x").catch((e) => e);
      await jest.advanceTimersByTimeAsync(15_001);
      await expect(pending).resolves.toMatchObject({ status: 504 });
    });

    // The old onramp client capped every timeout at its fifteen-second default
    // when no deadline was passed — so the NIN check's thirty seconds, added
    // because NIMC answers slowly, never applied.
    it("gives a NIN check the thirty seconds it asks for", async () => {
      silentProvider();
      let settled = false;
      const pending = onramp
        .submitCustomerKyc("veil_x", TEST_NIN)
        .catch((e) => e)
        .finally(() => (settled = true));
      await jest.advanceTimersByTimeAsync(15_001);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toMatchObject({ status: 504 });
    });

    it("never waits past the deadline it was given", async () => {
      silentProvider();
      const pending = linqCall("/x", { timeoutMs: 30_000, deadline: Date.now() + 2_000 }).catch((e) => e);
      await jest.advanceTimersByTimeAsync(2_001);
      await expect(pending).resolves.toMatchObject({ status: 504 });
    });
  });
});

// ─── Configuration and logging ──────────────────────────────────────────────

describe("configuration and logging", () => {
  // The onramp client built the auth header inside its network try/catch, so
  // a missing key was reported as "Could not reach Linq".
  it("reports a missing key as configuration (500), not as the provider being down", async () => {
    delete process.env.LINQ_API_KEY;
    const stub = provider(json(200, {}));
    await expect(onramp.getCustomerStatus("r")).rejects.toMatchObject({
      status: 500,
      message: "LINQ_API_KEY is not configured",
    });
    expect(stub).not.toHaveBeenCalled();
  });

  it("does not send the key to the public rate endpoints", async () => {
    const stub = provider(reply(200, "1500"));
    await onramp.getOnrampRate();
    expect(stub.mock.calls[0][1].headers).not.toHaveProperty("X-API-Key");
  });

  it("keeps a path prefix in LINQ_BASE_URL, and the query string", async () => {
    process.env.LINQ_BASE_URL = "https://linq.example/api/";
    const stub = provider(json(200, { status: "ok" }));
    await onramp.getOnrampStatus("veil x", "ord_1");
    await client.getOfframpStatus("ord 2");
    expect(String(stub.mock.calls[0][0])).toBe(
      "https://linq.example/api/b2b/onramp/status?customerRef=veil+x&orderId=ord_1",
    );
    expect(String(stub.mock.calls[1][0])).toBe("https://linq.example/api/b2b/status?id=ord%202");
  });

  it("never logs a request body, and redacts identifiers echoed in a response", async () => {
    provider(json(422, { message: `NIN ${TEST_NIN} could not be verified` }));
    await onramp.submitCustomerKyc("veil_x", TEST_NIN).catch(() => {});

    const logged = (console.warn as jest.Mock).mock.calls.flat().join("\n");
    expect(logged).toMatch(/422 from \/b2b\/customers\/kyc/);
    expect(logged).not.toContain(TEST_NIN);
    expect(logged).toContain("[redacted]");
    expect(logged).not.toContain("veil_x");
  });

  it("redacts long digit runs and truncates", () => {
    expect(loggableBody("phone 08012345678, acct 0123456789, code 123")).toBe(
      "phone [redacted], acct [redacted], code 123",
    );
    expect(loggableBody("x".repeat(600))).toHaveLength(500);
    expect(loggableBody("")).toBe("(empty)");
  });
});
