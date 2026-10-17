/**
 * Every route documented as safe to repeat, repeated (W090).
 *
 * The provider is the fake in `../fakes/linqProvider.ts`, not a per-test mock,
 * so where a guarantee depends on Linq it depends on the belief written there.
 * The database is an in-memory stand-in that enforces the same unique
 * constraints as `prisma/schema.prisma`, because one of the cases below is
 * decided by exactly that constraint.
 *
 * "Dropped response" here means three different things, and each is covered:
 *  - the client never got OUR answer, and sends the request again;
 *  - Linq's answer never reached US, and `retryOnProviderFailure` sends it again;
 *  - Linq did the work but WE failed before recording it, so the client's retry
 *    finds no row and has to go back to Linq.
 */
import express from "express";
import request from "supertest";

process.env.LINQ_API_KEY = "biz_live_test";

type Row = Record<string, any>;
const tables: Record<"offrampOrder" | "ngnOrder", Row[]> = { offrampOrder: [], ngnOrder: [] };
let nextId = 1;

/** The @@unique sets from prisma/schema.prisma, which is what makes a race lose. */
const UNIQUE: Record<keyof typeof tables, string[][]> = {
  offrampOrder: [
    ["network", "orderId"],
    ["network", "publicId"],
    ["network", "idempotencyKey"],
  ],
  ngnOrder: [["network", "orderId"]],
};

/** Prisma's compound-key `where`: `{ network_orderId: { network, orderId } }` or `{ id }`. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) =>
    value !== null && typeof value === "object"
      ? key.split("_").every((f) => row[f] === value[f])
      : row[key] === value,
  );
}

function uniqueViolation(table: keyof typeof tables, data: Row, self?: Row): Error | null {
  for (const fields of UNIQUE[table]) {
    if (fields.some((f) => data[f] == null)) continue;
    const clash = tables[table].find(
      (r) => r !== self && fields.every((f) => r[f] === data[f]),
    );
    if (clash) {
      return Object.assign(new Error(`Unique constraint failed on (${fields.join(", ")})`), {
        code: "P2002",
      });
    }
  }
  return null;
}

/** Let a microtask hop happen, so two requests genuinely interleave. */
const tick = () => new Promise((r) => setImmediate(r));

const mockCreateFailure = jest.fn<Error | null, []>(() => null);

function model(table: keyof typeof tables) {
  return {
    findUnique: jest.fn(async ({ where }: { where: Row }) => {
      await tick();
      return tables[table].find((r) => matches(r, where)) ?? null;
    }),
    findFirst: jest.fn(async ({ where }: { where: Row }) => {
      await tick();
      return tables[table].find((r) => matches(r, where)) ?? null;
    }),
    create: jest.fn(async ({ data }: { data: Row }) => {
      await tick();
      const injected = table === "offrampOrder" ? mockCreateFailure() : null;
      if (injected) throw injected;
      const violation = uniqueViolation(table, data);
      if (violation) throw violation;
      const row = { id: nextId++, createdAt: new Date(), updatedAt: new Date(), ...data };
      tables[table].push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      await tick();
      const row = tables[table].find((r) => matches(r, where));
      if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
    upsert: jest.fn(async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      await tick();
      const row = tables[table].find((r) => matches(r, where));
      if (row) return Object.assign(row, update);
      const created = { id: nextId++, createdAt: new Date(), updatedAt: new Date(), ...create };
      tables[table].push(created);
      return created;
    }),
  };
}

jest.mock("../../db", () => ({
  prisma: { offrampOrder: model("offrampOrder"), ngnOrder: model("ngnOrder") },
}));

import { createOfframpRouter } from "../../api/offramp";
import { createNgnRouter } from "../../api/ngn";
import { createLinqWebhookRouter } from "../../api/linqWebhook";
import { networkMiddleware } from "../../middleware/network";
import { computeSignature, SIGNATURE_HEADER } from "../../linq/webhook";
import { recordNgnOrder } from "../../linq/ngnOrders";
import { installFakeLinq, type FakeLinq } from "../fakes/linqProvider";

const DROP = { kind: "drop-after-work" } as const;
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WEBHOOK_SECRET = "whsec_test_secret";

function makeApp() {
  const app = express();
  // Ahead of express.json(), as in api.ts: the webhook verifies raw bytes.
  app.use("/webhooks/linq", createLinqWebhookRouter());
  app.use(express.json());
  app.use(networkMiddleware);
  app.use("/offramp", createOfframpRouter());
  app.use("/ngn", createNgnRouter());
  return app;
}

const offrampBody = (over: Record<string, unknown> = {}) => ({
  amountStableCoin: 50,
  bankAccount: "0000000000",
  bankCode: "000",
  bankName: "Fake Bank",
  accountName: "Test Person",
  walletAddress: WALLET,
  idempotencyKey: "idem-key-1",
  ...over,
});

// Plainly fake. None of these identify anyone.
const customerBody = {
  customerRef: "ref_test_0001",
  firstName: "Test",
  lastName: "Person",
  email: "test.person@example.com",
  phone: "00000000000",
};

let linq: FakeLinq;

beforeEach(() => {
  tables.offrampOrder.length = 0;
  tables.ngnOrder.length = 0;
  nextId = 1;
  mockCreateFailure.mockReset();
  mockCreateFailure.mockImplementation(() => null);
  process.env.NETWORKS = "testnet,mainnet";
  process.env.LINQ_WEBHOOK_SECRET = WEBHOOK_SECRET;
  linq = installFakeLinq();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  expect(linq.unhandled).toEqual([]);
  linq.restore();
});

// ─── POST /ngn/customers ──────────────────────────────────────────────────────

describe("POST /ngn/customers", () => {
  const provision = (app: express.Express) =>
    request(app).post("/ngn/customers").set("x-network", "mainnet").send(customerBody);

  it("the same request twice is one customer", async () => {
    const app = makeApp();
    const first = await provision(app);
    const second = await provision(app);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.body.created).toBe(true);
    expect(second.body.created).toBe(false);
    expect(linq.customers.size).toBe(1);
  });

  it("a client retrying after our response was dropped gets the same customer", async () => {
    const app = makeApp();
    await provision(app); // answered, but the client never saw it
    const retry = await provision(app);

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ customerRef: "ref_test_0001", verified: false, created: false });
    expect(linq.customers.size).toBe(1);
  });

  it("Linq's answer dropped on the way to us is retried into the same customer", async () => {
    linq.failNext("/b2b/customers", DROP);

    const res = await provision(makeApp());

    expect(res.status).toBe(200);
    expect(linq.callsTo("/b2b/customers")).toBe(2);
    expect(linq.customers.size).toBe(1);
  });
});

// ─── POST /offramp/orders ─────────────────────────────────────────────────────

describe("POST /offramp/orders", () => {
  const place = (app: express.Express, over: Record<string, unknown> = {}) =>
    request(app).post("/offramp/orders").send(offrampBody(over));

  it("the same key twice is one provider order and one row, and the replay says so", async () => {
    const app = makeApp();
    const first = await place(app);
    const second = await place(app);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.walletAddress).toBe(first.body.walletAddress);
    expect(tables.offrampOrder).toHaveLength(1);
    // Answered from our row: the replay never went back to Linq at all.
    expect(linq.callsTo("/b2b/offramp")).toBe(1);
    expect(linq.offrampOrders.size).toBe(1);
  });

  it("Linq's answer dropped on the way to us is one order, recorded once", async () => {
    linq.failNext("/b2b/offramp", DROP);

    const res = await place(makeApp());

    expect(res.status).toBe(201);
    expect(linq.callsTo("/b2b/offramp")).toBe(2);
    expect(linq.offrampOrders.size).toBe(1);
    expect(tables.offrampOrder).toHaveLength(1);
    expect(tables.offrampOrder[0].orderId).toBe([...linq.offrampOrders.keys()][0]);
  });

  it("Linq created it but we failed to record it: the client's retry finds the same order", async () => {
    // The order exists at Linq and nowhere here, so our own idempotency check
    // misses and the retry goes back to Linq. Only the provider's dedup on the
    // key keeps this to one order — the fake's belief, not ours to promise.
    mockCreateFailure.mockImplementationOnce(() => new Error("connection terminated"));
    const app = makeApp();

    const failed = await place(app);
    expect(failed.status).toBe(500);
    expect(linq.offrampOrders.size).toBe(1);
    expect(tables.offrampOrder).toHaveLength(0);

    const retry = await place(app);
    expect(retry.status).toBe(201);
    expect(linq.callsTo("/b2b/offramp")).toBe(2);
    expect(linq.offrampOrders.size).toBe(1);
    expect(tables.offrampOrder).toHaveLength(1);
  });

  it("two identical requests in flight at once are one order; the loser is told to retry, and can", async () => {
    // Both miss the existing-row check, both reach Linq (which dedupes on the
    // key), and the unique index on (network, idempotencyKey) refuses the
    // second insert. Nothing is duplicated — but the loser is answered 500
    // for an order that exists. Pinned so that is a known edge, not a surprise.
    const app = makeApp();
    const [a, b] = await Promise.all([place(app), place(app)]);

    expect([a.status, b.status].sort()).toEqual([201, 500]);
    expect(linq.offrampOrders.size).toBe(1);
    expect(tables.offrampOrder).toHaveLength(1);

    const retry = await place(app);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
  });

  it("the key is scoped to the network: the same key on mainnet is a separate order", async () => {
    const app = makeApp();
    await place(app);
    const other = await request(app)
      .post("/offramp/orders")
      .set("x-network", "mainnet")
      .send(offrampBody());

    expect(other.status).toBe(201);
    expect(tables.offrampOrder).toHaveLength(2);
    // Our rows are per network; whether Linq treats the key as per network is
    // unknown. The fake does not, and returns the testnet order's id.
    expect(linq.offrampOrders.size).toBe(1);
  });
});

// ─── recordNgnOrder ───────────────────────────────────────────────────────────

describe("recordNgnOrder", () => {
  const params = {
    network: "mainnet",
    kind: "onramp" as const,
    orderId: "00000000-0000-4000-8000-000000000001",
    customerRef: "ref_test_0001",
    walletAddress: WALLET,
    coin: "usdc",
    amountStableCoin: 10,
    amountNgn: 15000,
    rate: 1500,
    status: "pending",
  };

  it("recording the same order id twice keeps one row", async () => {
    await recordNgnOrder(params);
    await recordNgnOrder({ ...params, status: "processing" });

    expect(tables.ngnOrder).toHaveLength(1);
    expect(tables.ngnOrder[0].status).toBe("processing");
  });
});

// ─── POST /webhooks/linq ──────────────────────────────────────────────────────

describe("POST /webhooks/linq", () => {
  const deliver = (app: express.Express, event: Record<string, unknown>) => {
    const raw = JSON.stringify(event);
    return request(app)
      .post("/webhooks/linq")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, computeSignature(raw, WEBHOOK_SECRET))
      .send(raw);
  };

  /** The route answers before it reconciles; wait for the write to land. */
  const reconciled = async () => {
    for (let i = 0; i < 20; i++) await tick();
  };

  it("a redelivered event is applied once, and the second delivery changes nothing", async () => {
    const app = makeApp();
    const placed = await request(app).post("/offramp/orders").send(offrampBody());
    expect(placed.status).toBe(201);
    const orderId = tables.offrampOrder[0].orderId;

    const event = {
      event: "order.completed",
      orderId,
      status: "completed",
      amountStableCoin: 50,
      amountNGN: 75000,
      txHash: "f".repeat(64),
    };

    expect((await deliver(app, event)).status).toBe(200);
    await reconciled();
    const afterFirst: Row = { ...tables.offrampOrder[0], updatedAt: undefined };

    expect((await deliver(app, event)).status).toBe(200);
    await reconciled();
    const afterSecond: Row = { ...tables.offrampOrder[0], updatedAt: undefined };

    expect(afterFirst.status).toBe("completed");
    expect(afterFirst.settledNGN).toBe("75000");
    expect(afterSecond).toEqual(afterFirst);
    expect(tables.offrampOrder).toHaveLength(1);
  });

  it("a redelivered event for an onramp order does not create or duplicate a row", async () => {
    await recordNgnOrder({
      network: "mainnet",
      kind: "onramp",
      orderId: "00000000-0000-4000-8000-000000000002",
      customerRef: "ref_test_0001",
      walletAddress: WALLET,
      coin: "usdc",
      amountStableCoin: 10,
      amountNgn: 15000,
      rate: 1500,
      status: "pending",
    });
    const app = makeApp();
    const event = {
      event: "order.completed",
      orderId: "00000000-0000-4000-8000-000000000002",
      status: "completed",
      amountStableCoin: 10,
    };

    await deliver(app, event);
    await reconciled();
    await deliver(app, event);
    await reconciled();

    expect(tables.ngnOrder).toHaveLength(1);
    expect(tables.ngnOrder[0].status).toBe("completed");
    expect(tables.ngnOrder[0].settledStableCoin).toBe("10");
  });
});
