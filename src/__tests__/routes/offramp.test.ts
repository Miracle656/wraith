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

jest.mock("../../db", () => ({
  prisma: {
    offrampOrder: {
      findUnique: (args: any) => mockFindUnique(args),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: nextId++, createdAt: new Date("2026-01-01T00:00:00Z"), ...data };
        rows.push(row);
        return row;
      }),
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

import { createOfframpRouter } from "../../api/offramp";
import { networkMiddleware } from "../../middleware/network";
import { LinqError, createOfframpOrder, getOfframpStatus } from "../../linq/client";

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
