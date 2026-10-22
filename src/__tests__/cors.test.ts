/**
 * CORS, per surface.
 *
 * One `app.use(cors())` used to answer every request with
 * `Access-Control-Allow-Origin: *` — right for the public read API, and never
 * a decision for the routes that create orders. The policy now lives in
 * `src/middleware/cors.ts`; these tests pin the three answers that matter:
 *
 *  - an origin on the allow-list may call an allow-listed surface, and the
 *    response says which origin it was written for;
 *  - an origin that is not on the allow-list may not, and is refused before
 *    the route runs — so no order is created;
 *  - a request with no `Origin` header at all is served, because a native
 *    client (the mobile app), a server-to-server caller and `curl` all send
 *    none, and CORS has nothing to say about them.
 *
 * The allow-list comes from `CORS_ALLOWED_ORIGINS`, so the last group of tests
 * changes who is allowed by changing the environment, not this repository.
 */

import request from "supertest";

jest.mock("../db", () => ({
  getLastIndexedLedger: jest.fn().mockResolvedValue(1000),
  queryTransfers: jest.fn(),
  queryAllTransfers: jest.fn(),
  queryByTxHash: jest.fn(),
  querySummary: jest.fn(),
  queryNftTransfers: jest.fn(),
  getNftOwner: jest.fn(),
  getNftMetadata: jest.fn(),
  prisma: {
    $queryRawUnsafe: jest.fn(),
    $queryRaw: jest.fn(),
    webhookSubscription: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
    offrampOrder: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("../rpc", () => ({
  getLatestLedger: jest.fn().mockResolvedValue(1050),
}));

jest.mock("../indexer", () => ({
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest.fn().mockReturnValue({ uptimeSeconds: 0, totalIndexed: 0 }),
  isIndexerRunning: jest.fn().mockReturnValue(false),
  isIndexerStopped: jest.fn().mockReturnValue(false),
  getIndexerUnstartedReason: jest.fn(),
}));

// The real application still mounts its routers and middleware. Only the
// GraphQL server is replaced, to avoid starting its background work.
jest.mock("../graphql/server", () => ({
  createGraphQLMiddleware: () => {
    const router = require("express").Router();
    router.post("/", (_req: unknown, res: { json: (body: unknown) => void }) => res.json({ data: {} }));
    router.get("/", (_req: unknown, res: { json: (body: unknown) => void }) => res.json({ data: {} }));
    return router;
  },
}));

// The provider is never reached by these tests: a call out would spend the
// shared rate limit that every user of the rails shares.
jest.mock("../linq/client", () => ({
  ...jest.requireActual("../linq/client"),
  createOfframpOrder: jest.fn(),
  verifyBank: jest.fn(),
  checkStellarTrustline: jest.fn(),
  getOfframpStatus: jest.fn(),
}));

import { createApp, clearRpcHealthCache } from "../api";
import { createOfframpOrder } from "../linq/client";
import { prisma } from "../db";
import { corsPolicyFor, parseAllowedOrigins } from "../middleware/cors";

const WALLET = "https://wallet.example.com";
const ATTACKER = "https://evil.example.com";

const createSubscription = prisma.webhookSubscription.create as jest.Mock;

describe("the surface policy", () => {
  it.each([
    // Deliberately open: public chain data, and prices.
    ["GET", "/tokens", "open"],
    ["GET", "/accounts/GABC/transfers", "open"],
    ["GET", "/fees", "open"],
    ["POST", "/graphql", "open"],
    ["GET", "/offramp/rate", "open"],
    ["GET", "/offramp/availability", "open"],
    // Allow-listed: money, personal data, provider configuration.
    ["POST", "/offramp/orders", "allowlist"],
    ["GET", "/offramp/orders/order-1", "allowlist"],
    ["POST", "/offramp/verify-bank", "allowlist"],
    ["GET", "/offramp/trustline", "allowlist"],
    ["GET", "/ngn/onramp/rate", "allowlist"],
    ["POST", "/ngn/bills", "allowlist"],
    ["POST", "/webhooks", "allowlist"],
    ["DELETE", "/webhooks/7", "allowlist"],
    ["GET", "/metrics", "allowlist"],
    // Server to server: the provider's own callback.
    ["POST", "/webhooks/linq", "server"],
  ])("answers %s %s with %s", (method, path, policy) => {
    expect(corsPolicyFor(path, method).policy).toBe(policy);
  });

  it("restricts a write nobody has classified", () => {
    // The next route someone adds is restricted until somebody says otherwise.
    expect(corsPolicyFor("/payments", "POST").policy).toBe("allowlist");
  });

  it("matches a path prefix on segment boundaries", () => {
    // `/offramp/ordersomething` is not the orders surface, and `/offramp` does
    // not claim it either.
    expect(corsPolicyFor("/offramp/ordersomething", "GET").policy).toBe("open");
    expect(corsPolicyFor("/offrampfoo", "GET").policy).toBe("open");
  });
});

describe("the allow-list", () => {
  it("reads a comma-separated list and normalises each origin", () => {
    expect(
      parseAllowedOrigins(" https://wallet.example.com/ , https://app.example.com ,,https://wallet.example.com "),
    ).toEqual(["https://wallet.example.com", "https://app.example.com"]);
  });

  it("is empty when nothing is configured", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
  });
});

describe("the API", () => {
  const originalEnv = { ...process.env };
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    process.env.NETWORKS = "testnet";
    process.env.STELLAR_NETWORK = "testnet";
    process.env.CACHE_ENABLED = "false";
    process.env.CORS_ALLOWED_ORIGINS = WALLET;
    delete process.env.LINQ_API_KEY;
    delete process.env.LINQ_WEBHOOK_SECRET;
    clearRpcHealthCache();
    createSubscription.mockReset().mockResolvedValue({
      id: 7,
      url: "https://example.com/hook",
      filter: null,
      active: true,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    (createOfframpOrder as jest.Mock).mockReset();
    app = createApp();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ── An allowed origin ──────────────────────────────────────────────────────

  it("serves an allow-listed surface to an origin on the list", async () => {
    const res = await request(app).get("/metrics").set("Origin", WALLET);

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(WALLET);
    expect(res.headers["vary"]).toContain("Origin");
  });

  it("serves a write on an allow-listed surface to an origin on the list", async () => {
    const res = await request(app)
      .post("/webhooks")
      .set("Origin", WALLET)
      .send({ url: "https://example.com/hook", secret: "shhh" });

    expect(res.status).toBe(201);
    expect(res.headers["access-control-allow-origin"]).toBe(WALLET);
    expect(createSubscription).toHaveBeenCalledTimes(1);
  });

  // ── A disallowed origin ────────────────────────────────────────────────────

  it("refuses an allow-listed surface to an origin that is not on the list", async () => {
    const res = await request(app).get("/metrics").set("Origin", ATTACKER);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("origin_not_allowed");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses a write on an allow-listed surface before the order is created", async () => {
    const res = await request(app)
      .post("/offramp/orders")
      .set("Origin", ATTACKER)
      .send({ amount: 1000, bankAccount: "0123456789", bankCode: "058" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("origin_not_allowed");
    // The point of refusing rather than merely withholding the CORS headers:
    // a browser would have sent the request either way.
    expect(createOfframpOrder).not.toHaveBeenCalled();
  });

  it("names the surface that refused, so a client can tell which rule it hit", async () => {
    const res = await request(app).post("/ngn/bills").set("Origin", ATTACKER).send({});

    expect(res.status).toBe(403);
    expect(res.body.surface).toBe("ngn-rails");
  });

  // ── No origin at all ───────────────────────────────────────────────────────

  it("serves a request with no Origin header, the way a native client sends it", async () => {
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    // No CORS headers, because there is no origin to answer.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("serves a write with no Origin header", async () => {
    const res = await request(app)
      .post("/webhooks")
      .send({ url: "https://example.com/hook", secret: "shhh" });

    expect(res.status).toBe(201);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(createSubscription).toHaveBeenCalledTimes(1);
  });

  // ── The surfaces that are deliberately open ────────────────────────────────

  it("leaves the public read API open to every origin", async () => {
    const res = await request(app).get("/tokens").set("Origin", ATTACKER);

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("leaves the fee quote open to every origin", async () => {
    const res = await request(app).get("/fees").set("Origin", ATTACKER);

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("leaves the GraphQL endpoint open to every origin, including a POST", async () => {
    const res = await request(app).post("/graphql").set("Origin", ATTACKER).send({ query: "{ health { ok } }" });

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("leaves the offramp quotes open to every origin", async () => {
    process.env.LINQ_API_KEY = "test-key";
    app = createApp();

    const res = await request(app).get("/offramp/availability").set("Origin", ATTACKER);

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  // ── The provider callback ──────────────────────────────────────────────────

  it("gives the provider's callback no CORS headers and does not refuse it", async () => {
    const res = await request(app).post("/webhooks/linq").set("Origin", ATTACKER).send({});

    // Refused by the signature check, which is the gate that belongs there —
    // not by the origin policy, which must never stop a payment rail.
    expect(res.status).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  // ── Preflight ──────────────────────────────────────────────────────────────

  it("answers a preflight from an allowed origin", async () => {
    const res = await request(app)
      .options("/ngn/onramp/orders")
      .set("Origin", WALLET)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(WALLET);
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("refuses a preflight from an origin that is not on the list", async () => {
    const res = await request(app)
      .options("/ngn/onramp/orders")
      .set("Origin", ATTACKER)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("origin_not_allowed");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  // ── The allow-list is configuration ────────────────────────────────────────

  it("takes the allow-list from the environment, not from the source", async () => {
    process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com";
    app = createApp();

    const refused = await request(app).get("/metrics").set("Origin", WALLET);
    const allowed = await request(app).get("/metrics").set("Origin", "https://app.example.com");

    expect(refused.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });

  it("refuses every browser origin when no allow-list is configured, and still serves the ones without an origin", async () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    app = createApp();

    const refused = await request(app).get("/metrics").set("Origin", WALLET);
    const served = await request(app).get("/metrics");

    expect(refused.status).toBe(403);
    expect(served.status).toBe(200);
  });
});
