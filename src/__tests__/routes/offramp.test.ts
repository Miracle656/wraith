/**
 * GET /offramp/orders/:orderId used to hand any caller holding an order id the
 * bank payout amount, the deposit address and the rate. These tests pin who can
 * read an order, and what each kind of refusal is allowed to reveal.
 */
import express from "express";
import request from "supertest";

process.env.LINQ_API_KEY = "test-key";

type Row = Record<string, any>;
const rows: Row[] = [];
let nextId = 1;

const mockFindUnique = jest.fn(async ({ where }: { where: Record<string, any> }) => {
  const [key, value] = Object.entries(where)[0] as [string, Row];
  const fields = key.split("_");
  return rows.find((r) => fields.every((f) => r[f] === value[f])) ?? null;
});

const mockRowCreate = jest.fn(async ({ data }: { data: Row }) => {
  const row = { id: nextId++, createdAt: new Date("2026-01-01T00:00:00Z"), ...data };
  rows.push(row);
  return row;
});

jest.mock("../../db", () => ({
  prisma: {
    offrampOrder: {
      findUnique: (args: any) => mockFindUnique(args),
      create: (args: any) => mockRowCreate(args),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = where.id
          ? rows.find((r) => r.id === where.id)
          : rows.find(
              (r) =>
                r.network === where.network_orderId.network &&
                r.orderId === where.network_orderId.orderId,
            );
        Object.assign(row!, data);
        return row;
      }),
    },
  },
}));

jest.mock("../../linq/client", () => ({
  ...jest.requireActual("../../linq/client"),
  createOfframpOrder: jest.fn(),
  getOfframpStatus: jest.fn(),
}));

jest.mock("../../api/ngn", () => ({
  ngnPerCoin: jest.fn(),
}));

import { createOfframpRouter, requestFingerprint, __resetCoinlessRateLog } from "../../api/offramp";
import { networkMiddleware } from "../../middleware/network";
import { LinqError, createOfframpOrder, getOfframpStatus } from "../../linq/client";
import { ngnPerCoin } from "../../api/ngn";

const mockCreate = createOfframpOrder as jest.Mock;
const mockStatus = getOfframpStatus as jest.Mock;

const LINQ_ID = "3f7c1b2a-84e9-4c11-b3d2-0a9f7e123456";
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(networkMiddleware);
  app.use("/offramp", createOfframpRouter());
  return app;
}

const body = (over: Record<string, unknown> = {}) => ({
  amountStableCoin: 50,
  bankAccount: "0123456789",
  bankCode: "058",
  bankName: "Test Bank",
  accountName: "Ada Lovelace",
  walletAddress: WALLET,
  idempotencyKey: "key-1",
  ...over,
});

let linqSeq = 0;
function linqOrder(over: Record<string, unknown> = {}) {
  return {
    id: over.id ?? (linqSeq++ === 0 ? LINQ_ID : `linq-order-${linqSeq}`),
    walletAddress: "GDEPOSITADDRESS",
    coinType: "usdc",
    coin: "usdc",
    chain: "stellar",
    amountStableCoin: 50,
    amountNGN: 82750,
    rate: 1655,
    currency: "NGN",
    status: "initiated",
    ...over,
  };
}

async function place(app: express.Express, over: Record<string, unknown> = {}) {
  const res = await request(app).post("/offramp/orders").send(body(over));
  return res;
}

beforeEach(() => {
  rows.length = 0;
  nextId = 1;
  linqSeq = 0;
  mockCreate.mockReset();
  mockStatus.mockReset();
  mockFindUnique.mockClear();
  mockRowCreate.mockClear();
  mockCreate.mockImplementation(async () => linqOrder());
  mockStatus.mockImplementation(async (id: string) => ({
    id,
    status: "initiated",
    amountStableCoin: 50,
    amountNGN: 82750,
    currency: "NGN",
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
  }));
  delete process.env.OFFRAMP_LOOKUP_MAX_FAILURES;
  delete process.env.OFFRAMP_MAX_AMOUNT_NGN;
  delete process.env.OFFRAMP_MAX_AMOUNT_STABLECOIN;
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("creating an order", () => {
  it("returns an unguessable id and an access token instead of the provider's id", async () => {
    const res = await place(makeApp());

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^ofr_[A-Za-z0-9_-]{22}$/);
    expect(res.body.accessToken).toMatch(/^oft_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(res.body)).not.toContain(LINQ_ID);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("stores the token's hash, never the token", async () => {
    const res = await place(makeApp());

    expect(rows).toHaveLength(1);
    expect(rows[0].publicId).toBe(res.body.id);
    expect(rows[0].orderId).toBe(LINQ_ID);
    expect(JSON.stringify(rows)).not.toContain(res.body.accessToken);
    expect(rows[0].accessTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives every order its own id and token", async () => {
    const app = makeApp();
    const a = await place(app, { idempotencyKey: "key-a" });
    const b = await place(app, { idempotencyKey: "key-b" });

    expect(a.body.id).not.toBe(b.body.id);
    expect(a.body.accessToken).not.toBe(b.body.accessToken);
  });
});

describe("reading an order", () => {
  it("lets the creator read their own order", async () => {
    const app = makeApp();
    const created = await place(app);

    const res = await request(app)
      .get(`/offramp/orders/${created.body.id}`)
      .set(auth(created.body.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.depositAddress).toBe("GDEPOSITADDRESS");
    expect(res.body.rate).toBe(1655);
    // The provider is asked about its own id, but is never named or exposed.
    expect(mockStatus).toHaveBeenCalledWith(LINQ_ID);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(res.body)).not.toContain(LINQ_ID);
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain("linq");
  });

  it("refuses a valid order id with no token, and reveals nothing about the order", async () => {
    const app = makeApp();
    const created = await place(app);
    mockFindUnique.mockClear();

    const res = await request(app).get(`/offramp/orders/${created.body.id}`);

    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(JSON.stringify(res.body)).not.toContain("GDEPOSITADDRESS");
    expect(mockStatus).not.toHaveBeenCalled();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("refuses the wrong token", async () => {
    const app = makeApp();
    const created = await place(app);
    const other = await place(app, { idempotencyKey: "key-2" });

    const res = await request(app)
      .get(`/offramp/orders/${created.body.id}`)
      .set(auth(other.body.accessToken));

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("GDEPOSITADDRESS");
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("answers a wrong token, an unknown id and a malformed id identically", async () => {
    const app = makeApp();
    const created = await place(app);
    const stranger = await place(app, { idempotencyKey: "key-2" });

    const wrongToken = await request(app)
      .get(`/offramp/orders/${created.body.id}`)
      .set(auth(stranger.body.accessToken));
    const unknownId = await request(app)
      .get(`/offramp/orders/ofr_${"A".repeat(22)}`)
      .set(auth(created.body.accessToken));
    const malformed = await request(app)
      .get(`/offramp/orders/${LINQ_ID}`)
      .set(auth(created.body.accessToken));

    expect(wrongToken.status).toBe(404);
    for (const other of [unknownId, malformed]) {
      expect(other.status).toBe(wrongToken.status);
      expect(other.body).toEqual(wrongToken.body);
    }
  });

  it("does not accept the provider's id as a lookup key", async () => {
    const app = makeApp();
    const created = await place(app);

    const res = await request(app)
      .get(`/offramp/orders/${LINQ_ID}`)
      .set(auth(created.body.accessToken));

    expect(res.status).toBe(404);
  });

  it("cannot read an order on another network", async () => {
    const app = makeApp();
    const created = await place(app);
    rows[0].network = "mainnet";

    const res = await request(app)
      .get(`/offramp/orders/${created.body.id}`)
      .set(auth(created.body.accessToken));

    expect(res.status).toBe(404);
  });

  it("keeps orders that predate access control unreadable", async () => {
    const app = makeApp();
    rows.push({
      id: nextId++,
      network: "testnet",
      orderId: LINQ_ID,
      publicId: null,
      accessTokenHash: null,
      depositAddress: "GDEPOSITADDRESS",
      createdAt: new Date(),
    });

    const byProviderId = await request(app)
      .get(`/offramp/orders/${LINQ_ID}`)
      .set(auth(`oft_${"A".repeat(43)}`));

    expect(byProviderId.status).toBe(404);
  });

  it("does not read a row that has an id but no stored token", async () => {
    const app = makeApp();
    const id = `ofr_${"B".repeat(22)}`;
    rows.push({ id: nextId++, network: "testnet", orderId: LINQ_ID, publicId: id, accessTokenHash: null });

    const res = await request(app)
      .get(`/offramp/orders/${id}`)
      .set(auth(`oft_${"A".repeat(43)}`));

    expect(res.status).toBe(404);
  });

  it("serves the stored order without leaking the failure when the provider is down", async () => {
    const app = makeApp();
    const created = await place(app);
    mockStatus.mockRejectedValue(new LinqError("Linq is down: key lq_live_secret rejected", 503));

    const res = await request(app)
      .get(`/offramp/orders/${created.body.id}`)
      .set(auth(created.body.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("cache");
    const text = JSON.stringify(res.body).toLowerCase();
    expect(text).not.toContain("linq");
    expect(text).not.toContain("lq_live_secret");
  });

  it("never returns or logs a raw database error", async () => {
    const app = makeApp();
    const created = await place(app);
    const secret = "connection refused postgres://user:hunter2@db.internal/wraith";
    mockFindUnique.mockRejectedValueOnce(new Error(secret));
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .get(`/offramp/orders/${created.body.id}`)
      .set(auth(created.body.accessToken));

    expect(res.status).toBe(500);
    expect(res.text).not.toContain("hunter2");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("hunter2");
    logged.mockRestore();
  });
});

describe("brute-forcing lookups", () => {
  it("rate-limits repeated failed lookups", async () => {
    process.env.OFFRAMP_LOOKUP_MAX_FAILURES = "3";
    const app = makeApp();
    const created = await place(app);
    const guess = () =>
      request(app)
        .get(`/offramp/orders/ofr_${"C".repeat(22)}`)
        .set(auth(created.body.accessToken));

    expect((await guess()).status).toBe(404);
    expect((await guess()).status).toBe(404);
    expect((await guess()).status).toBe(404);
    const limited = await guess();

    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatch(/too many/i);
  });

  it("counts lookups with no token as failures too", async () => {
    process.env.OFFRAMP_LOOKUP_MAX_FAILURES = "2";
    const app = makeApp();
    const created = await place(app);

    await request(app).get(`/offramp/orders/${created.body.id}`);
    await request(app).get(`/offramp/orders/${created.body.id}`);
    const res = await request(app).get(`/offramp/orders/${created.body.id}`);

    expect(res.status).toBe(429);
  });

  it("does not spend the budget on the creator polling their own order", async () => {
    process.env.OFFRAMP_LOOKUP_MAX_FAILURES = "3";
    const app = makeApp();
    const created = await place(app);

    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .get(`/offramp/orders/${created.body.id}`)
        .set(auth(created.body.accessToken));
      expect(res.status).toBe(200);
    }
  });

  it("limits the token check as well, and a good token is still refused once the budget is gone", async () => {
    process.env.OFFRAMP_LOOKUP_MAX_FAILURES = "2";
    const app = makeApp();
    const created = await place(app);
    const stranger = `oft_${"D".repeat(43)}`;

    await request(app).get(`/offramp/orders/${created.body.id}`).set(auth(stranger));
    await request(app).get(`/offramp/orders/${created.body.id}`).set(auth(stranger));
    const res = await request(app)
      .get(`/offramp/orders/${created.body.id}`)
      .set(auth(created.body.accessToken));

    expect(res.status).toBe(429);
  });
});

describe("retrying an order creation", () => {
  it("refuses a replay that changes the amount instead of reporting success", async () => {
    const app = makeApp();
    const first = await place(app);
    expect(first.status).toBe(201);

    // Same wallet, same key, different amount. This used to answer 200 with the
    // FIRST order's figures and `replayed: true`, so a caller that reused a key
    // after editing the amount was told its new payout had been accepted while
    // the money followed the original order.
    const changed = await place(app, { amountStableCoin: 500 });

    expect(changed.status).toBe(409);
    expect(changed.body.error).toMatch(/different request/i);
    // Nothing new reached the provider and no second row exists.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });

  it("treats a differently-formatted but equal amount as the same request", async () => {
    const app = makeApp();
    await place(app);
    // "50" and "50.00" are the same order; a replay must not 409 on formatting.
    const retry = await place(app, { amountStableCoin: "50.00" });

    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("re-issues the token, keeps the id, and does not create a second order", async () => {
    const app = makeApp();
    const first = await place(app);
    const retry = await place(app);

    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.accessToken).toMatch(/^oft_[A-Za-z0-9_-]{43}$/);
    expect(retry.body.accessToken).not.toBe(first.body.accessToken);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);

    // The token from the response that may never have arrived no longer works.
    const stale = await request(makeApp())
      .get(`/offramp/orders/${first.body.id}`)
      .set(auth(first.body.accessToken));
    const fresh = await request(makeApp())
      .get(`/offramp/orders/${first.body.id}`)
      .set(auth(retry.body.accessToken));
    expect(stale.status).toBe(404);
    expect(fresh.status).toBe(200);
  });

  it("gives nothing away to another wallet reusing the key", async () => {
    const app = makeApp();
    await place(app);

    const res = await place(app, { walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKOH" });

    expect(res.status).toBe(409);
    expect(res.text).not.toContain("GDEPOSITADDRESS");
    expect(res.body.accessToken).toBeUndefined();
    expect(rows[0].accessTokenHash).toBeDefined();
  });

  it("adopts an order that predates access control instead of leaving it stuck", async () => {
    const app = makeApp();
    rows.push({
      id: nextId++,
      network: "testnet",
      orderId: LINQ_ID,
      idempotencyKey: "key-1",
      walletAddress: WALLET,
      publicId: null,
      accessTokenHash: null,
      depositAddress: "GDEPOSITADDRESS",
      chain: "stellar",
      coin: "usdc",
      amountStableCoin: "50",
      amountNGN: "82750",
      rate: "1655",
      status: "initiated",
    });

    const res = await place(app);

    expect(res.status).toBe(200);
    expect(res.body.id).toMatch(/^ofr_[A-Za-z0-9_-]{22}$/);
    expect(rows[0].publicId).toBe(res.body.id);
    expect(JSON.stringify(res.body)).not.toContain(LINQ_ID);
  });
});

const mockNgnPerCoin = ngnPerCoin as jest.Mock;

describe("GET /offramp/rate — naira per coin, not naira per dollar", () => {
  // The bug this fixes: the old handler called getRate() which returns Linq's
  // /b2b/rate number — naira per dollar.  Dividing a naira amount by that
  // gives the right USDC figure by coincidence (1 USDC = $1) and the wrong
  // figure for every other asset by that asset's price.
  //
  // The rollout is staged because installed APKs cannot be updated from here:
  // an unknown coin is refused today, while a missing coin is still answered —
  // priced for USDC, which is the number those builds already get — and logged.
  // See the note in api/offramp.ts.

  let warnings: string[];

  beforeEach(() => {
    // 1,655 NGN per USDC (dollar-pegged, so same as NGN/USD)
    // 290 NGN per XLM  (XLM ≈ $0.175 × 1,655)
    mockNgnPerCoin.mockImplementation(async (coin: string) =>
      coin === "usdc" ? 1655 : 290,
    );
    warnings = [];
    jest
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => void warnings.push(args.join(" ")));
    __resetCoinlessRateLog();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function rateUrl(coin?: string) {
    const app = makeApp();
    const req = request(app).get("/offramp/rate");
    return coin === undefined ? req : req.query({ coin });
  }

  it("returns naira per XLM for coin=xlm", async () => {
    const res = await rateUrl("xlm");
    expect(res.status).toBe(200);
    expect(res.body.coin).toBe("xlm");
    expect(res.body.rate).toBeCloseTo(290, 6);
    expect(res.body.indicative).toBe(true);
    expect(mockNgnPerCoin).toHaveBeenCalledWith("xlm", "offramp");
  });

  it("returns naira per USDC for coin=usdc", async () => {
    const res = await rateUrl("usdc");
    expect(res.status).toBe(200);
    expect(res.body.coin).toBe("usdc");
    expect(res.body.rate).toBeCloseTo(1655, 6);
    expect(res.body.indicative).toBe(true);
    expect(mockNgnPerCoin).toHaveBeenCalledWith("usdc", "offramp");
  });

  it("XLM and USDC rates differ — pins that the old dollar rate is gone", async () => {
    const xlm = await rateUrl("xlm");
    const usdc = await rateUrl("usdc");
    expect(xlm.body.rate).not.toBeCloseTo(usdc.body.rate, 0);
  });

  it("answers a coin-less request with the USDC rate it gets today", async () => {
    const res = await rateUrl();
    expect(res.status).toBe(200);
    expect(res.body.rate).toBeCloseTo(1655, 6);
    expect(mockNgnPerCoin).toHaveBeenCalledWith("usdc", "offramp");
  });

  it("names the coin a coin-less answer is priced for", async () => {
    // The client-side half of the staged rollout depends on this: a build that
    // asks for no coin can read which asset it was actually quoted for instead
    // of assuming its dollar figure was a coin figure.
    const res = await rateUrl();
    expect(res.body.coin).toBe("usdc");
  });

  it("logs a coin-less request as deprecated, once per caller", async () => {
    await rateUrl();
    await rateUrl();
    const deprecation = warnings.filter((w) => w.includes("deprecated"));
    expect(deprecation).toHaveLength(1);
    expect(deprecation[0]).toContain("/offramp/rate without coin");
    expect(deprecation[0]).toContain("usdc");
  });

  it("does not log a deprecation for a request that named a coin", async () => {
    await rateUrl("xlm");
    expect(warnings.filter((w) => w.includes("deprecated"))).toHaveLength(0);
  });

  it("refuses an unknown coin — a coin we cannot price is not a default", async () => {
    const res = await rateUrl("doge");
    expect(res.status).toBe(400);
    expect(mockNgnPerCoin).not.toHaveBeenCalled();
  });

  it("refuses an empty-string coin, which is a caller bug rather than an old APK", async () => {
    // `?coin=` parses as an empty string: a client that built the query and
    // lost the value must not be answered with a USDC number it will treat as
    // XLM. Only a request that never sent the parameter is legacy.
    const app = makeApp();
    const res = await request(app).get("/offramp/rate?coin=");
    expect(res.status).toBe(400);
    expect(mockNgnPerCoin).not.toHaveBeenCalled();
  });

  it("accepts a coin in any case, so an old caller is not refused for casing", async () => {
    const app = makeApp();
    const res = await request(app).get("/offramp/rate").query({ coin: "XLM" });
    expect(res.status).toBe(200);
    expect(res.body.coin).toBe("xlm");
  });

  it("the response carries no currency field — rate is already in NGN", async () => {
    const res = await rateUrl("usdc");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("currency");
  });

  it("surfaces a pricing failure rather than returning a stale rate", async () => {
    mockNgnPerCoin.mockRejectedValueOnce(new LinqError("Could not price XLM right now", 502));
    const res = await rateUrl("xlm");
    expect(res.status).toBe(502);
  });
});

/**
 * The endpoint `isOfframpAvailable()` is meant to call instead of the rate one.
 * What makes it usable as a gate is that it cannot price anything: a check that
 * runs every time an app opens must not spend the provider allowance that every
 * rate read shares.
 */
describe("GET /offramp/availability", () => {
  beforeEach(() => {
    // Call history is process-wide across describes in this file, and this test
    // is about an absence of calls.
    mockNgnPerCoin.mockClear();
  });

  it("answers without touching the price path", async () => {
    const res = await request(makeApp()).get("/offramp/availability");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
    expect(mockNgnPerCoin).not.toHaveBeenCalled();
  });

  it("is never cached, because a stale 200 keeps offering a tile that 503s", async () => {
    const res = await request(makeApp()).get("/offramp/availability");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("says so when this deployment has no payout key", async () => {
    const saved = process.env.LINQ_API_KEY;
    delete process.env.LINQ_API_KEY;
    try {
      const res = await request(makeApp()).get("/offramp/availability");
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/i);
    } finally {
      process.env.LINQ_API_KEY = saved;
    }
  });
});

describe("validating the amount", () => {
  // Every one of these used to reach the provider: Number("abc") is NaN, and
  // Number() also accepts negatives, zero, "" and booleans.
  it.each([
    ["a non-numeric string", "abc"],
    ["a negative number", -5],
    ["zero", 0],
    ["an empty string", ""],
    ["Infinity as a string", "Infinity"],
    ["an exponent that overflows", "1e999"],
    ["a boolean", true],
    ["an array", [5]],
    ["an object", { value: 5 }],
  ])("answers 400 before any provider call for %s", async (_label, bad) => {
    const res = await place(makeApp(), { amountStableCoin: bad });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amountStableCoin/);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("answers 400 for a non-numeric amountNGN, and names that field", async () => {
    const res = await place(makeApp(), { amountStableCoin: undefined, amountNGN: "abc" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amountNGN/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("requires an amount of some kind", async () => {
    const res = await place(makeApp(), { amountStableCoin: undefined });

    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("accepts an amount sent as a decimal string and passes the number on", async () => {
    const res = await place(makeApp(), { amountStableCoin: "50.50" });

    expect(res.status).toBe(201);
    expect(mockCreate.mock.calls[0][0].amountStableCoin).toBe(50.5);
  });

  it("bounds naira and stablecoin separately", async () => {
    // 200,000 is a small naira payout and an enormous USDC one.
    const naira = await place(makeApp(), {
      amountStableCoin: undefined,
      amountNGN: 200_000,
      idempotencyKey: "key-naira",
    });
    const usdc = await place(makeApp(), {
      amountStableCoin: 200_000,
      idempotencyKey: "key-usdc",
    });

    expect(naira.status).toBe(201);
    expect(usdc.status).toBe(400);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses an amount above the configured ceiling", async () => {
    process.env.OFFRAMP_MAX_AMOUNT_STABLECOIN = "100";

    const over = await place(makeApp(), { amountStableCoin: 101 });
    const at = await place(makeApp(), { amountStableCoin: 100, idempotencyKey: "key-at" });

    expect(over.status).toBe(400);
    expect(at.status).toBe(201);
  });

  it("falls back to the default bound when the configured one is not a number", async () => {
    // A typo in config used to become a bound of NaN, which rejects everything.
    process.env.OFFRAMP_MAX_AMOUNT_STABLECOIN = "ten thousand";
    process.env.OFFRAMP_MAX_AMOUNT_NGN = "-1";

    const usdc = await place(makeApp(), { amountStableCoin: 50 });
    const tooMuch = await place(makeApp(), {
      amountStableCoin: 10_001,
      idempotencyKey: "key-too-much",
    });
    const naira = await place(makeApp(), {
      amountStableCoin: undefined,
      amountNGN: 10_000_001,
      idempotencyKey: "key-naira",
    });

    expect(usdc.status).toBe(201);
    expect(tooMuch.status).toBe(400);
    expect(naira.status).toBe(400);
  });
});

describe("binding an idempotency key to the request", () => {
  it("stores a keyed fingerprint that does not contain the bank details", async () => {
    await place(makeApp());

    expect(rows[0].requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].requestHash).not.toContain("0123456789");
  });

  it.each([
    ["bankAccount", { bankAccount: "9999999999" }],
    ["bankCode", { bankCode: "044" }],
    ["accountName", { accountName: "Someone Else" }],
    [
      "refundAddress",
      { refundAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKOH" },
    ],
  ])("refuses a replay that changes only the %s", async (_field, change) => {
    const app = makeApp();
    const first = await place(app);
    expect(first.status).toBe(201);
    const tokenHash = rows[0].accessTokenHash;

    const replay = await place(app, change);

    expect(replay.status).toBe(409);
    expect(replay.body.error).toMatch(/different order details/i);
    expect(replay.body.accessToken).toBeUndefined();
    expect(replay.body.replayed).toBeUndefined();
    // Nothing new reached the provider, and the first order's token is untouched.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].accessTokenHash).toBe(tokenHash);
  });

  it("still treats an identical retry as a replay", async () => {
    const app = makeApp();
    await place(app);
    const retry = await place(app);

    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
  });

  it("keeps the same fingerprint for the same request, and a different one for another", async () => {
    await place(makeApp(), { idempotencyKey: "key-a" });
    await place(makeApp(), { idempotencyKey: "key-b" });
    await place(makeApp(), { idempotencyKey: "key-c", bankAccount: "9999999999" });

    expect(rows[0].requestHash).toBe(rows[1].requestHash);
    expect(rows[2].requestHash).not.toBe(rows[0].requestHash);
  });
});

describe("concurrent duplicates", () => {
  const uniqueViolation = () =>
    Object.assign(
      new Error("Unique constraint failed on the fields: (`network`,`idempotencyKey`)"),
      { code: "P2002" },
    );

  // The second of two simultaneous taps: its lookup ran before the first tap's row
  // was written (so it finds nothing), it created the order at the provider, and
  // its insert then loses to the row that now exists.
  async function placeLosingTheRace(app: express.Express, over: Record<string, unknown> = {}) {
    mockFindUnique.mockImplementationOnce(async () => null);
    mockRowCreate.mockImplementationOnce(async () => {
      throw uniqueViolation();
    });
    return place(app, over);
  }

  it("answers 200 replayed, not 500, and returns our id and a fresh token", async () => {
    const app = makeApp();
    const first = await place(app);
    expect(first.status).toBe(201);

    const loser = await placeLosingTheRace(app);

    expect(loser.status).toBe(200);
    expect(loser.body.replayed).toBe(true);
    expect(loser.body.id).toBe(first.body.id);
    expect(loser.body.id).toMatch(/^ofr_[A-Za-z0-9_-]{22}$/);
    expect(loser.body.accessToken).toMatch(/^oft_[A-Za-z0-9_-]{43}$/);
    expect(loser.body.accessToken).not.toBe(first.body.accessToken);
    expect(loser.headers["cache-control"]).toBe("no-store");
    expect(rows).toHaveLength(1);

    // The id is one the lookup route accepts, and the token it returns opens it.
    const read = await request(makeApp())
      .get(`/offramp/orders/${loser.body.id}`)
      .set(auth(loser.body.accessToken));
    expect(read.status).toBe(200);
  });

  it("never returns the provider's order id", async () => {
    const app = makeApp();
    await place(app);

    const loser = await placeLosingTheRace(app);

    expect(JSON.stringify(loser.body)).not.toContain(LINQ_ID);
  });

  it("does not let the race answer for a different wallet", async () => {
    const app = makeApp();
    await place(app);

    const loser = await placeLosingTheRace(app, {
      walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKOH",
    });

    expect(loser.status).toBe(409);
    expect(loser.body.accessToken).toBeUndefined();
    expect(loser.body.id).toBeUndefined();
    expect(loser.text).not.toContain("GDEPOSITADDRESS");
  });

  it("does not let the race answer for different order details", async () => {
    const app = makeApp();
    await place(app);

    const loser = await placeLosingTheRace(app, { bankAccount: "9999999999" });

    expect(loser.status).toBe(409);
    expect(loser.body.accessToken).toBeUndefined();
  });

  it("does not leak the database error if the winning row cannot be read back", async () => {
    const app = makeApp();
    mockRowCreate.mockImplementationOnce(async () => {
      throw uniqueViolation();
    });
    // Nothing is there to adopt: the insert failed on a constraint we cannot explain.
    const res = await place(app);

    expect(res.status).toBe(500);
    // #287: even our own unexpected failure answers with the one shape.
    expect(res.body).toEqual({ error: "Offramp request failed", code: "internal_error" });
    expect(res.text).not.toMatch(/Unique constraint|idempotencyKey|P2002/);
  });
});

// #319: the order token and the keyed fingerprint. Assertions compare tokens as
// booleans, so a failure reports true/false rather than printing a credential.
describe("the order access token", () => {
  it("reads its own order", async () => {
    const app = makeApp();
    const created = await place(app);

    const res = await request(app)
      .get(`/offramp/orders/${created.body.id}`)
      .set(auth(created.body.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.id === created.body.id).toBe(true);
  });

  it("does not open another order", async () => {
    const app = makeApp();
    const a = await place(app);
    const b = await place(app, { idempotencyKey: "key-2" });

    const res = await request(app).get(`/offramp/orders/${b.body.id}`).set(auth(a.body.accessToken));

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Order not found" });
  });

  it("refuses a tampered token", async () => {
    const app = makeApp();
    const created = await place(app);
    const token: string = created.body.accessToken;
    const last = token.charAt(token.length - 1);
    const tampered = token.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(tampered === token).toBe(false);

    const res = await request(app).get(`/offramp/orders/${created.body.id}`).set(auth(tampered));

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Order not found" });
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("refuses a token that is not the right shape at all", async () => {
    const app = makeApp();
    const created = await place(app);

    const res = await request(app)
      .get(`/offramp/orders/${created.body.id}`)
      .set(auth(`${created.body.accessToken}x`));

    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
  });

  it("refuses a missing token", async () => {
    const app = makeApp();
    const created = await place(app);

    const res = await request(app).get(`/offramp/orders/${created.body.id}`);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "An order access token is required" });
  });
});

describe("the keyed fingerprint without a key", () => {
  const request0 = {
    amountStableCoin: 50,
    bankAccount: "0123456789",
    bankCode: "058",
    accountName: "Ada Lovelace",
    refundAddress: undefined,
    walletAddress: WALLET,
  };

  afterEach(() => {
    process.env.LINQ_API_KEY = "test-key";
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", "   "],
  ])("refuses to mint when the key is %s", (_label, value) => {
    if (value === undefined) delete process.env.LINQ_API_KEY;
    else process.env.LINQ_API_KEY = value;

    expect(requestFingerprint(request0)).toBeNull();
  });

  it("mints a 64-hex fingerprint once a key is set", () => {
    expect(requestFingerprint(request0)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never reaches the provider or the database when the key is missing", async () => {
    process.env.LINQ_API_KEY = "";
    const app = makeApp();

    const res = await place(app);

    expect(res.status).toBe(503);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRowCreate).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });
});

describe("a replayed order creation", () => {
  it("creates exactly one order however many times it is replayed", async () => {
    const app = makeApp();
    const first = await place(app);
    const replays = [await place(app), await place(app), await place(app)];

    expect(first.status).toBe(201);
    for (const r of replays) {
      expect(r.status).toBe(200);
      expect(r.body.replayed).toBe(true);
      expect(r.body.id === first.body.id).toBe(true);
    }
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRowCreate).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });
});
