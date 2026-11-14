/**
 * #287 — one error shape across `/ngn` and `/offramp`.
 *
 * The acceptance criteria, asserted directly:
 *  - every failure on both surfaces carries a stable machine-readable `code`
 *    beside the human `error` — at least one failure per rail (offramp,
 *    onramp, bills), plus the gates and handlers both surfaces share;
 *  - existing codes keep their current values (the ones installed APKs branch
 *    on — `coin_not_available`, `rate_out_of_date`, `invalid_nin_format`,
 *    `veil_rate_limited`, `rate_limited` are asserted in their own suites and
 *    re-checked here where a rail crosses them);
 *  - nothing else rides along: no connection string, key or stack can reach a
 *    response body — checked here by making our own failure carry exactly
 *    such a string and proving it never surfaces.
 *
 * The provider is never reached: every provider-facing call is mocked. This
 * service moves real money against a provider with no sandbox, and the shared
 * rate limit is real — a test that called out would spend it.
 */
import express from "express";
import request from "supertest";

import { createNgnRouter } from "../../api/ngn";
import { createOfframpRouter } from "../../api/offramp";
import { networkMiddleware } from "../../middleware/network";
import { RAIL_ERROR_CODES } from "../../api/errors";
import { LinqError } from "../../linq/client";
import { withOpenApiResponseValidation } from "../../openapi/responseValidator";

jest.mock("../../linq/onramp", () => {
  const actual = jest.requireActual("../../linq/onramp");
  return {
    ...actual,
    provisionCustomer: jest.fn(),
    getCustomerStatus: jest.fn(),
    submitCustomerKyc: jest.fn(),
    getOnrampRate: jest.fn(),
    createOnrampOrder: jest.fn(),
    getOnrampStatus: jest.fn(),
  };
});
jest.mock("../../linq/bills", () => {
  const actual = jest.requireActual("../../linq/bills");
  return { ...actual, payBill: jest.fn(), getBillStatus: jest.fn() };
});
jest.mock("../../linq/ngnOrders", () => ({
  recordNgnOrder: jest.fn().mockResolvedValue(undefined),
  findNgnOrder: jest.fn().mockResolvedValue(null),
}));

// The offramp router reads Prisma at creation time (the idempotency lookup);
// an empty store is all these cases need.
jest.mock("../../db", () => ({
  prisma: {
    offrampOrder: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("../../linq/client", () => ({
  ...jest.requireActual("../../linq/client"),
  createOfframpOrder: jest.fn(),
  getOfframpStatus: jest.fn(),
}));

import { createOfframpOrder } from "../../linq/client";

const G_ADDRESS = "GBUO4RL4RTGRFSUDUMRFMC75EWYCRTX5OE3PBIXJVDCZULOXQ2TKDR4Z";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(networkMiddleware);
  app.use("/ngn", createNgnRouter());
  app.use("/offramp", createOfframpRouter());
  return withOpenApiResponseValidation(app);
}

const mainnet = (r: request.Test) => r.set("x-network", "mainnet");

/** Assert the one error shape: exactly `error` (string) + `code` (string). */
function expectRailShape(body: Record<string, unknown>): void {
  expect(Object.keys(body).sort()).toEqual(["code", "error"]);
  expect(typeof body.error).toBe("string");
  expect(typeof body.code).toBe("string");
  expect(String(body.code).length).toBeGreaterThan(0);
}

beforeEach(() => {
  process.env.LINQ_API_KEY = "biz_live_test";
  process.env.NETWORKS = "testnet,mainnet";
  jest.clearAllMocks();
});

describe("every failure per rail carries the one error shape", () => {
  it("offramp: a refused order creation", async () => {
    (createOfframpOrder as jest.Mock).mockRejectedValue(new LinqError("Refused", 409));

    const res = await mainnet(
      request(makeApp()).post("/offramp/orders").send({
        amountStableCoin: 50,
        bankAccount: "0123456789",
        bankCode: "058",
        bankName: "Test Bank",
        accountName: "Ada Lovelace",
        walletAddress: G_ADDRESS,
        idempotencyKey: "shape-key-1",
      }),
    );

    expect(res.status).toBe(409);
    expectRailShape(res.body);
    expect(res.body.code).toBe("provider_rejected");
    expect(res.body.error).toBe("Refused");
  });

  it("offramp: a missing order access token", async () => {
    const res = await mainnet(request(makeApp()).get("/offramp/orders/ofr_missing"));

    expect(res.status).toBe(401);
    expectRailShape(res.body);
    expect(res.body.code).toBe("unauthorized");
  });

  it("onramp: a coin Linq cannot source", async () => {
    const res = await mainnet(
      request(makeApp()).post("/ngn/onramp/orders").send({
        customerRef: "u",
        amountStableCoin: 1,
        walletAddress: G_ADDRESS,
        rate: 1450,
        coin: "usdc",
      }),
    );

    expect(res.status).toBe(400);
    expectRailShape(res.body);
    // Installed APKs branch on this exact value — it must never change.
    expect(res.body.code).toBe("coin_not_available");
  });

  it("bills: a category the biller does not serve", async () => {
    const res = await mainnet(
      request(makeApp()).post("/ngn/bills").send({
        customerRef: "u",
        billCategory: "lottery",
        provider: "MTN",
        customerId: "08012345678",
        amountNgn: 1000,
        amountStableCoin: 0.66,
        rate: 1500,
        coin: "usdc",
        refundAddress: G_ADDRESS,
      }),
    );

    expect(res.status).toBe(400);
    expectRailShape(res.body);
    expect(res.body.code).toBe("invalid_request");
  });
});

describe("the gates both surfaces share", () => {
  it("an unconfigured deployment answers 503 with a code, on both rails", async () => {
    delete process.env.LINQ_API_KEY;

    for (const path of ["/ngn/onramp/rate?coin=xlm", "/offramp/availability"]) {
      const res = await mainnet(request(makeApp()).get(path));
      expect(res.status).toBe(503);
      expectRailShape(res.body);
      expect(res.body.code).toBe("not_configured");
    }
  });

  it("the mainnet gate answers with its own code, not the generic fallback", async () => {
    const res = await request(makeApp())
      .get("/ngn/onramp/rate?coin=xlm")
      .set("x-network", "testnet");

    expect(res.status).toBe(400);
    expectRailShape(res.body);
    expect(res.body.code).toBe("mainnet_only");
  });

  it("a bad network selector is refused before either rail runs", async () => {
    const res = await request(makeApp()).get("/offramp/availability?network=mainet");

    expect(res.status).toBe(400);
    expectRailShape(res.body);
    expect(res.body.code).toBe("invalid_network");
  });
});

describe("our own failures leak nothing", () => {
  it("answers a raw database failure with the shape and none of its detail", async () => {
    // Deliberately hostile: a raw driver error is exactly the thing that once
    // reached callers — connection string, table name and all.
    const hostile = new Error(
      'connect ECONNREFUSED postgresql://wraith:s3cr3t@db.internal:5432/wraith\n' +
        "    at Connection.<anonymous> (/app/node_modules/pg/lib/client.js:131:17)",
    );
    (createOfframpOrder as jest.Mock).mockRejectedValue(hostile);

    const res = await mainnet(
      request(makeApp()).post("/offramp/orders").send({
        amountStableCoin: 50,
        bankAccount: "0123456789",
        bankCode: "058",
        bankName: "Test Bank",
        accountName: "Ada Lovelace",
        walletAddress: G_ADDRESS,
        idempotencyKey: "shape-key-2",
      }),
    );

    expect(res.status).toBe(500);
    expectRailShape(res.body);
    expect(res.body.code).toBe("internal_error");
    expect(res.body.error).toBe("Offramp request failed");

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("postgresql://");
    expect(raw).not.toContain("s3cr3t");
    expect(raw).not.toContain("ECONNREFUSED");
    expect(raw).not.toContain("node_modules");
    expect(raw).not.toContain("biz_live_test");
  });
});

describe("the code catalog", () => {
  it("holds every wraith-assigned code a rail answers with", () => {
    // A code the client cannot discover is not an API: this list is what
    // docs/ngn-rails.md documents, so an addition here needs a docs line too.
    expect(new Set(RAIL_ERROR_CODES).size).toBe(RAIL_ERROR_CODES.length);
    for (const code of [
      "not_configured",
      "invalid_request",
      "mainnet_only",
      "veil_rate_limited",
      "rate_limited",
      "coin_not_available",
      "rate_out_of_date",
      "invalid_nin_format",
      "idempotency_conflict",
      "unauthorized",
      "order_not_found",
      "provider_rejected",
      "provider_error",
      "internal_error",
    ]) {
      expect(RAIL_ERROR_CODES).toContain(code);
    }
  });
});
