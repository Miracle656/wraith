/**
 * The money-failure record: what breaks, who can see it, and what never
 * belongs in it.
 *
 * A failed payout used to tell nobody. These tests pin the three failure
 * kinds the record exists for — a rejected payout, an order that ended
 * failed, and a reconciliation that gave up — plus the line the issue draws:
 * a 400 for a malformed bank code is not an incident and must leave no row.
 *
 * The provider is the fake in `../fakes/linqProvider.ts`, never Linq: Linq has
 * no sandbox and every call moves real naira. The database is an in-memory
 * stand-in with the same compound-key shapes as `prisma/schema.prisma`.
 *
 * No personal data appears anywhere below — no NIN, no phone number, plainly
 * fake names and accounts only, as in the other KYC-adjacent fixtures.
 */
import express from "express";
import request from "supertest";

process.env.LINQ_API_KEY = "biz_live_test";

type Row = Record<string, any>;
const tables: Record<"offrampOrder" | "ngnOrder" | "moneyFailure", Row[]> = {
  offrampOrder: [],
  ngnOrder: [],
  moneyFailure: [],
};
let nextId = 1;

/** Prisma's compound-key `where`: `{ network_kind_orderId: {...} }` or `{ id }`. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) =>
    value !== null && typeof value === "object"
      ? key.split("_").every((f) => row[f] === value[f])
      : row[key] === value,
  );
}

/** Let a microtask hop happen, so the webhook's reply and its write interleave. */
const tick = () => new Promise((r) => setImmediate(r));

/** Injected once into offrampOrder.update, to make a reconciliation give up. */
let failOfframpUpdateOnce: Error | null = null;

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
      const row = { id: nextId++, createdAt: new Date(), updatedAt: new Date(), ...data };
      tables[table].push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      await tick();
      if (table === "offrampOrder" && failOfframpUpdateOnce) {
        const injected = failOfframpUpdateOnce;
        failOfframpUpdateOnce = null;
        throw injected;
      }
      const row = tables[table].find((r) => matches(r, where));
      if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
    upsert: jest.fn(async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      await tick();
      const row = tables[table].find((r) => matches(r, where));
      if (row) {
        const { occurrences, ...rest } = update;
        Object.assign(row, rest, { updatedAt: new Date() });
        if (occurrences?.increment) row.occurrences += occurrences.increment;
        return row;
      }
      const created = {
        id: nextId++,
        occurrences: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...create,
      };
      tables[table].push(created);
      return created;
    }),
    findMany: jest.fn(
      async ({ where = {}, orderBy, take }: { where?: Row; orderBy?: Row; take?: number }) => {
        await tick();
        let rows = tables[table].filter((r) =>
          Object.entries(where).every(([k, v]) => r[k] === v),
        );
        if (orderBy?.id === "desc") rows = [...rows].sort((a, b) => b.id - a.id);
        return take !== undefined ? rows.slice(0, take) : rows;
      },
    ),
  };
}

jest.mock("../../db", () => ({
  prisma: {
    offrampOrder: model("offrampOrder"),
    ngnOrder: model("ngnOrder"),
    moneyFailure: model("moneyFailure"),
  },
}));

// The creating paths go through the real client into the fake provider's
// fetch; only the status poll is stubbed, because its answer is the fallback
// case (a failed order the webhook never announced).
jest.mock("../../linq/client", () => ({
  ...jest.requireActual("../../linq/client"),
  getOfframpStatus: jest.fn(),
}));

import { prisma } from "../../db";
import { createOfframpRouter } from "../../api/offramp";
import { createLinqWebhookRouter } from "../../api/linqWebhook";
import { createOpsRouter } from "../../api/ops";
import { networkMiddleware } from "../../middleware/network";
import { getOfframpStatus } from "../../linq/client";
import { recordNgnOrder } from "../../linq/ngnOrders";
import { computeSignature, SIGNATURE_HEADER } from "../../linq/webhook";
import { moneyFailuresTotal, _resetMetrics } from "../../metrics";
import { installFakeLinq, type FakeLinq } from "../fakes/linqProvider";

const mockStatus = getOfframpStatus as jest.Mock;

const WEBHOOK_SECRET = "whsec_test_secret";
const OPS_TOKEN = "ops_token_correct_horse_battery";
// Plainly fake. None of these identify anyone.
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
// Deliberately not a digit string that could appear inside an id: a fixture
// whose value is a substring of every UUID would make the "never stored"
// assertions below pass or fail at random.
const BANK_ACCOUNT = "9876543210";

const offrampBody = (over: Record<string, unknown> = {}) => ({
  amountStableCoin: 50,
  bankAccount: BANK_ACCOUNT,
  bankCode: "000",
  bankName: "Fake Bank",
  accountName: "Test Person",
  walletAddress: WALLET,
  idempotencyKey: "idem-key-1",
  ...over,
});

let linq: FakeLinq;

function makeApp() {
  const app = express();
  // Ahead of express.json(), as in api.ts: the webhook verifies raw bytes.
  app.use("/webhooks/linq", createLinqWebhookRouter());
  app.use(express.json());
  app.use(networkMiddleware);
  app.use("/offramp", createOfframpRouter());
  app.use("/ops", createOpsRouter());
  return app;
}

/** Signed webhook delivery, as Linq sends it. */
function deliver(app: express.Express, event: Record<string, unknown>) {
  const raw = JSON.stringify(event);
  return request(app)
    .post("/webhooks/linq")
    .set("Content-Type", "application/json")
    .set(SIGNATURE_HEADER, computeSignature(raw, WEBHOOK_SECRET))
    .send(raw);
}

/** The route answers before it reconciles; wait for the write to land. */
async function reconciled() {
  for (let i = 0; i < 20; i++) await tick();
}

/** Place an offramp order through the fake provider; returns its provider id. */
async function placeOrder(app: express.Express, over: Record<string, unknown> = {}) {
  const res = await request(app).post("/offramp/orders").send(offrampBody(over));
  expect(res.status).toBe(201);
  return res.body as { id: string; accessToken: string };
}

beforeEach(() => {
  tables.offrampOrder.length = 0;
  tables.ngnOrder.length = 0;
  tables.moneyFailure.length = 0;
  nextId = 1;
  failOfframpUpdateOnce = null;
  process.env.NETWORKS = "testnet,mainnet";
  process.env.LINQ_WEBHOOK_SECRET = WEBHOOK_SECRET;
  delete process.env.OPS_TOKEN;
  delete process.env.OFFRAMP_LOOKUP_MAX_FAILURES;
  _resetMetrics();
  mockStatus.mockReset();
  linq = installFakeLinq();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  expect(linq.unhandled).toEqual([]);
  linq.restore();
});

// ─── A rejected payout (offramp order ended failed) ──────────────────────────

describe("a rejected payout", () => {
  it("is recorded durably, naming the rail, the order and what failed", async () => {
    const app = makeApp();
    const placed = await placeOrder(app);
    const orderId = tables.offrampOrder[0].orderId;

    await deliver(app, {
      event: "order.failed",
      orderId,
      status: "failed: beneficiary account rejected",
    });
    await reconciled();

    expect(tables.moneyFailure).toHaveLength(1);
    const failure = tables.moneyFailure[0];
    expect(failure.rail).toBe("offramp");
    expect(failure.kind).toBe("payout_rejected");
    expect(failure.orderId).toBe(orderId);
    expect(failure.publicId).toBe(placed.id);
    expect(failure.providerCode).toBe("failed: beneficiary account rejected");
    expect(failure.message).toContain("the naira payout did not complete");
    // The order row itself moved to the failed status too — the record and
    // the order agree.
    expect(tables.offrampOrder[0].status).toBe("failed: beneficiary account rejected");
  });

  it("a redelivery keeps one row and counts the second sighting", async () => {
    const app = makeApp();
    await placeOrder(app);
    const orderId = tables.offrampOrder[0].orderId;
    const failed = {
      event: "order.failed",
      orderId,
      status: "failed: beneficiary account rejected",
    };

    await deliver(app, failed);
    await reconciled();
    await deliver(app, failed);
    await reconciled();

    expect(tables.moneyFailure).toHaveLength(1);
    expect(tables.moneyFailure[0].occurrences).toBe(2);
  });

  it("a failed order the webhook never announced is caught by a status poll", async () => {
    const app = makeApp();
    const placed = await placeOrder(app);
    const orderId = tables.offrampOrder[0].orderId;
    // No webhook at all — the delivery was lost. The wallet's own poll is the
    // only thing that ever learns the payout failed.
    mockStatus.mockResolvedValue({
      id: orderId,
      status: "timeout: payout never completed",
      amountStableCoin: 50,
      amountNGN: 75000,
      currency: "NGN",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });

    const res = await request(app)
      .get(`/offramp/orders/${placed.id}`)
      .set("Authorization", `Bearer ${placed.accessToken}`);
    expect(res.status).toBe(200);

    expect(tables.moneyFailure).toHaveLength(1);
    const failure = tables.moneyFailure[0];
    expect(failure.kind).toBe("payout_rejected");
    expect(failure.rail).toBe("offramp");
    expect(failure.orderId).toBe(orderId);
    expect(failure.publicId).toBe(placed.id);
    expect(tables.offrampOrder[0].status).toBe("timeout: payout never completed");
  });

  it("webhook and poll describing the same order converge on one incident", async () => {
    const app = makeApp();
    const placed = await placeOrder(app);
    const orderId = tables.offrampOrder[0].orderId;

    await deliver(app, { event: "order.failed", orderId, status: "failed" });
    await reconciled();

    // The provider's poll words the same failure differently — a second
    // sighting of one failed order, not a second incident.
    mockStatus.mockResolvedValue({
      id: orderId,
      status: "failed: beneficiary account rejected",
      amountStableCoin: 50,
      amountNGN: 75000,
      currency: "NGN",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });
    await request(app)
      .get(`/offramp/orders/${placed.id}`)
      .set("Authorization", `Bearer ${placed.accessToken}`);

    expect(tables.moneyFailure).toHaveLength(1);
    expect(tables.moneyFailure[0].occurrences).toBe(2);
  });

  it("counts in metrics with bounded labels only", async () => {
    const app = makeApp();
    await placeOrder(app);
    await deliver(app, {
      event: "order.failed",
      orderId: tables.offrampOrder[0].orderId,
      status: "failed",
    });
    await reconciled();

    const metric = await moneyFailuresTotal.get();
    const sample = metric.values.find(
      (v) => v.labels.rail === "offramp" && v.labels.kind === "payout_rejected",
    );
    expect(sample).toBeDefined();
    expect(sample!.labels.network).toBe("testnet");
    // Every label is drawn from a finite set — never an order id, an amount
    // or a provider message, which would grow /metrics until it cannot be
    // scraped.
    expect(Object.keys(sample!.labels).sort()).toEqual(["kind", "network", "rail"]);
  });

  it("never carries bank details or an NIN-shaped value into the record", async () => {
    const app = makeApp();
    await placeOrder(app);
    await deliver(app, {
      event: "order.failed",
      orderId: tables.offrampOrder[0].orderId,
      status: "failed",
    });
    await reconciled();

    const serialized = JSON.stringify(tables.moneyFailure);
    expect(serialized).not.toContain(BANK_ACCOUNT);
    expect(serialized).not.toContain("Test Person");
    // A Nigerian NIN is 11 digits. Nothing in this table needs a value of
    // that shape, so the pattern appearing here would be a leak.
    expect(serialized).not.toMatch(/\b\d{11}\b/);
  });
});

// ─── An order that ended failed (onramp/bill) ────────────────────────────────

describe("an order that ended failed after the user paid", () => {
  it("is recorded on the rail the order was placed on", async () => {
    await recordNgnOrder({
      // The webhook carries no network, so reconciliation resolves it with
      // currentNetwork() — testnet by default. Seed the order on that same
      // network or the compound-key lookup will not find it.
      network: "testnet",
      kind: "bill",
      orderId: "00000000-0000-4000-8000-0000000000b1",
      customerRef: "ref_test_0001",
      walletAddress: WALLET,
      coin: "usdc",
      amountStableCoin: 1,
      amountNgn: 1500,
      rate: 1500,
      status: "processing",
      billCategory: "airtime",
      provider: "Fake Telco",
    });

    await deliver(makeApp(), {
      event: "order.failed",
      orderId: "00000000-0000-4000-8000-0000000000b1",
      status: "failed: provider declined",
    });
    await reconciled();

    expect(tables.moneyFailure).toHaveLength(1);
    const failure = tables.moneyFailure[0];
    expect(failure.kind).toBe("order_failed");
    expect(failure.rail).toBe("bill");
    expect(failure.network).toBe("testnet");
    expect(failure.orderId).toBe("00000000-0000-4000-8000-0000000000b1");
    expect(failure.message).toContain("Bill order ended as");
    expect(tables.ngnOrder[0].status).toBe("failed: provider declined");
  });

  it("an onramp failure is recorded as onramp, not bill", async () => {
    await recordNgnOrder({
      network: "testnet",
      kind: "onramp",
      orderId: "00000000-0000-4000-8000-0000000000a1",
      customerRef: "ref_test_0001",
      walletAddress: WALLET,
      coin: "xlm",
      amountStableCoin: 10,
      amountNgn: 15000,
      rate: 1500,
      status: "processing",
    });

    await deliver(makeApp(), {
      event: "order.failed",
      orderId: "00000000-0000-4000-8000-0000000000a1",
      status: "timeout",
    });
    await reconciled();

    expect(tables.moneyFailure).toHaveLength(1);
    expect(tables.moneyFailure[0].rail).toBe("onramp");
    expect(tables.moneyFailure[0].kind).toBe("order_failed");
  });
});

// ─── Reconciliation gave up ──────────────────────────────────────────────────

describe("when reconciliation gives up", () => {
  it("records the give-up, answers the delivery 200, and keeps error detail out of the row", async () => {
    const app = makeApp();
    await placeOrder(app);
    const orderId = tables.offrampOrder[0].orderId;

    failOfframpUpdateOnce = new Error("connection terminated mid-transaction");

    const res = await deliver(app, { event: "order.failed", orderId, status: "failed" });
    await reconciled();

    // Linq times out at 10s and redelivers; the ack must not depend on the
    // write that just failed.
    expect(res.status).toBe(200);

    expect(tables.moneyFailure).toHaveLength(1);
    const failure = tables.moneyFailure[0];
    expect(failure.kind).toBe("reconcile_failed");
    expect(failure.rail).toBe("unknown");
    expect(failure.orderId).toBe(orderId);
    expect(failure.message).toContain("could not be reconciled");
    // The error's name only — its message carries database detail that stays
    // in the log, not in an operator-facing record.
    expect(failure.message).toContain("Error");
    expect(failure.message).not.toContain("connection terminated");
  });

  it("still counts in metrics when the failure row itself cannot be written", async () => {
    const app = makeApp();
    await placeOrder(app);
    failOfframpUpdateOnce = new Error("db unreachable");
    // The database is fully down now: even the incident row cannot land.
    jest.spyOn(prisma.moneyFailure, "upsert").mockRejectedValueOnce(
      Object.assign(new Error("db down"), { code: "P1001" }),
    );

    await deliver(app, {
      event: "order.failed",
      orderId: tables.offrampOrder[0].orderId,
      status: "failed",
    });
    await reconciled();

    expect(tables.moneyFailure).toHaveLength(0);
    const metric = await moneyFailuresTotal.get();
    const total = metric.values.reduce((sum, v) => sum + v.value, 0);
    expect(total).toBeGreaterThanOrEqual(1);
  });
});

// ─── Ordinary errors are excluded ────────────────────────────────────────────

describe("ordinary validation errors are not incidents", () => {
  it("a 400 for a malformed request leaves no failure row", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/offramp/orders")
      .send(offrampBody({ bankAccount: undefined }));

    expect(res.status).toBe(400);
    expect(linq.callsTo("/b2b/offramp")).toBe(0);
    expect(tables.moneyFailure).toHaveLength(0);
  });

  it("a provider 400 for a bad bank code leaves no failure row", async () => {
    // Nothing moved: the provider refused before creating an order, which is
    // the exact case the issue says must not become an incident.
    linq.failNext("/b2b/offramp", {
      kind: "refuse",
      status: 400,
      body: { error: "bank code is invalid" },
    });

    const res = await request(makeApp()).post("/offramp/orders").send(offrampBody());

    expect(res.status).toBe(400);
    // The provider's own message, first letter capitalised by the pass-through
    // helper — asserted verbatim so a scrubbing change is a deliberate one.
    expect(res.body.error).toBe("Bank code is invalid");
    expect(tables.moneyFailure).toHaveLength(0);
  });

  it("a completed order leaves no failure row", async () => {
    const app = makeApp();
    await placeOrder(app);
    await deliver(app, {
      event: "order.completed",
      orderId: tables.offrampOrder[0].orderId,
      status: "completed",
      amountStableCoin: 50,
      amountNGN: 75000,
    });
    await reconciled();

    expect(tables.offrampOrder[0].status).toBe("completed");
    expect(tables.moneyFailure).toHaveLength(0);
  });
});

// ─── GET /ops/failures — the operator surface ────────────────────────────────

describe("GET /ops/failures", () => {
  async function recordTwoFailures(app: express.Express) {
    await placeOrder(app, { idempotencyKey: "idem-key-1" });
    await deliver(app, {
      event: "order.failed",
      orderId: tables.offrampOrder[0].orderId,
      status: "failed",
    });
    await reconciled();
    await recordNgnOrder({
      network: "testnet",
      kind: "bill",
      orderId: "00000000-0000-4000-8000-0000000000b2",
      customerRef: "ref_test_0001",
      walletAddress: WALLET,
      coin: "usdc",
      amountStableCoin: 1,
      amountNgn: 1500,
      rate: 1500,
      status: "processing",
    });
    await deliver(app, {
      event: "order.failed",
      orderId: "00000000-0000-4000-8000-0000000000b2",
      status: "failed: provider declined",
    });
    await reconciled();
  }

  const auth = { Authorization: `Bearer ${OPS_TOKEN}` };

  it("is not configured at all until OPS_TOKEN is set", async () => {
    const res = await request(makeApp()).get("/ops/failures");
    expect(res.status).toBe(503);
  });

  it("refuses a missing or wrong token", async () => {
    process.env.OPS_TOKEN = OPS_TOKEN;
    const app = makeApp();

    const missing = await request(app).get("/ops/failures");
    const wrong = await request(app)
      .get("/ops/failures")
      .set("Authorization", "Bearer ops_token_wrong");

    expect(missing.status).toBe(401);
    expect(missing.headers["www-authenticate"]).toBe("Bearer");
    expect(wrong.status).toBe(401);
  });

  it("lists recent failures newest first, without database access", async () => {
    process.env.OPS_TOKEN = OPS_TOKEN;
    const app = makeApp();
    await recordTwoFailures(app);

    const res = await request(app).get("/ops/failures").set(auth);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.failures).toHaveLength(2);
    // Newest first: the bill failure was recorded last.
    const [newest, oldest] = res.body.failures;
    expect(newest.kind).toBe("order_failed");
    expect(newest.rail).toBe("bill");
    expect(oldest.kind).toBe("payout_rejected");
    expect(oldest.rail).toBe("offramp");
    // Every row names its rail, its order and what failed.
    for (const failure of res.body.failures) {
      expect(failure).toMatchObject({
        network: expect.any(String),
        rail: expect.any(String),
        kind: expect.any(String),
        orderId: expect.any(String),
        message: expect.any(String),
        occurrences: expect.any(Number),
        firstSeenAt: expect.any(String),
        lastSeenAt: expect.any(String),
      });
    }
    // No bank details, no amounts, never a NIN.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(BANK_ACCOUNT);
    expect(serialized).not.toContain("Test Person");
    expect(serialized).not.toMatch(/\b\d{11}\b/);
  });

  it("filters by rail and kind, and refuses an unknown one", async () => {
    process.env.OPS_TOKEN = OPS_TOKEN;
    const app = makeApp();
    await recordTwoFailures(app);

    const byRail = await request(app).get("/ops/failures?rail=offramp").set(auth);
    expect(byRail.status).toBe(200);
    expect(byRail.body.failures).toHaveLength(1);
    expect(byRail.body.failures[0].rail).toBe("offramp");

    const byKind = await request(app).get("/ops/failures?kind=order_failed").set(auth);
    expect(byKind.status).toBe(200);
    expect(byKind.body.failures).toHaveLength(1);
    expect(byKind.body.failures[0].kind).toBe("order_failed");

    // The filters are a bounded vocabulary, so a typo is refused rather than
    // silently matching nothing.
    const unknown = await request(app).get("/ops/failures?rail=swift").set(auth);
    expect(unknown.status).toBe(400);
  });

  it("honours limit and caps it", async () => {
    process.env.OPS_TOKEN = OPS_TOKEN;
    const app = makeApp();
    await recordTwoFailures(app);

    const one = await request(app).get("/ops/failures?limit=1").set(auth);
    expect(one.body.failures).toHaveLength(1);
    expect(one.body.limit).toBe(1);

    const silly = await request(app).get("/ops/failures?limit=99999").set(auth);
    expect(silly.status).toBe(200);
    expect(silly.body.limit).toBe(200);
  });
});
