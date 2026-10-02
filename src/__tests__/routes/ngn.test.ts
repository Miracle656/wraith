/**
 * The naira routes. Every one of these moves real money and Linq has no
 * sandbox, so the guards are the product.
 *
 * The three that matter most:
 *  - a contract address is refused wherever Linq would be asked to pay to it,
 *  - the testnet build cannot reach any of this,
 *  - the NIN never appears in a response.
 */
import express from "express";
import request from "supertest";

import { createNgnRouter } from "../../api/ngn";
import { networkMiddleware } from "../../middleware/network";

jest.mock("../../linq/onramp", () => {
  const actual = jest.requireActual("../../linq/onramp");
  return {
    ...actual,
    provisionCustomer: jest.fn(),
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

import {
  createOnrampOrder,
  getOnrampRate,
  getOnrampStatus,
  provisionCustomer,
  submitCustomerKyc,
} from "../../linq/onramp";
import { getBillStatus, payBill } from "../../linq/bills";
import { findNgnOrder, recordNgnOrder } from "../../linq/ngnOrders";
import { LinqError } from "../../linq/client";

const G_ADDRESS = "GBUO4RL4RTGRFSUDUMRFMC75EWYCRTX5OE3PBIXJVDCZULOXQ2TKDR4Z";
const C_ADDRESS = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(networkMiddleware);
  app.use("/ngn", createNgnRouter());
  return app;
}

/** Mainnet is the only network these routes serve. */
const mainnet = (r: request.Test) => r.set("x-network", "mainnet");

beforeEach(() => {
  process.env.LINQ_API_KEY = "biz_live_test";
  // `networkMiddleware` refuses a network this deployment has not enabled, so
  // mainnet has to be opted into here the same way a real deployment does.
  process.env.NETWORKS = "testnet,mainnet";
  jest.clearAllMocks();
});

describe("configuration gate", () => {
  it("answers 503 when the key is absent, so a client can gate its CTA", async () => {
    delete process.env.LINQ_API_KEY;
    const res = await mainnet(request(makeApp()).get("/ngn/onramp/rate"));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });
});

describe("mainnet gate", () => {
  // Linq has no sandbox. A `G…` address is valid on both networks, so a testnet
  // order would take real naira and deliver real crypto to an address the
  // testnet wallet never shows — paid, and nothing visible.
  it("refuses the whole surface on testnet", async () => {
    const res = await request(makeApp()).get("/ngn/onramp/rate").set("x-network", "testnet");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only available on mainnet/i);
    expect(getOnrampRate).not.toHaveBeenCalled();
  });

  it("refuses order creation on testnet before reaching Linq", async () => {
    const res = await request(makeApp())
      .post("/ngn/onramp/orders")
      .set("x-network", "testnet")
      .send({ customerRef: "u", amountStableCoin: 6, walletAddress: G_ADDRESS, rate: 1, coin: "xlm" });

    expect(res.status).toBe(400);
    expect(createOnrampOrder).not.toHaveBeenCalled();
  });
});

describe("contract addresses are refused wherever Linq would pay to one", () => {
  // Linq pays by classic operation, and a classic payment cannot name a
  // contract as its destination. The receive screen made this mistake once.
  it("refuses a C-address as the onramp destination", async () => {
    const res = await mainnet(
      request(makeApp())
        .post("/ngn/onramp/orders")
        .send({ customerRef: "u", amountStableCoin: 6, walletAddress: C_ADDRESS, rate: 1, coin: "xlm" }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/classic account, not the smart-wallet contract/i);
    expect(createOnrampOrder).not.toHaveBeenCalled();
  });

  // Worse here than on a delivery: it fails at the moment the user has already
  // paid and been told their money is coming back.
  it("refuses a C-address as a bill refund address", async () => {
    const res = await mainnet(
      request(makeApp()).post("/ngn/bills").send({
        customerRef: "u",
        billCategory: "airtime",
        provider: "MTN",
        customerId: "08012345678",
        amountNgn: 1000,
        amountStableCoin: 0.75,
        rate: 1333,
        coin: "xlm",
        refundAddress: C_ADDRESS,
      }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/refundAddress must be the classic account/i);
    expect(payBill).not.toHaveBeenCalled();
  });

  it("refuses a malformed address too, not just a contract", async () => {
    const res = await mainnet(
      request(makeApp())
        .post("/ngn/onramp/orders")
        .send({ customerRef: "u", amountStableCoin: 6, walletAddress: "nonsense", rate: 1, coin: "xlm" }),
    );
    expect(res.status).toBe(400);
    expect(createOnrampOrder).not.toHaveBeenCalled();
  });
});

describe("KYC", () => {
  it("passes the NIN through and returns nothing containing it", async () => {
    (submitCustomerKyc as jest.Mock).mockResolvedValue({
      customerRef: "u",
      verified: true,
      status: "verified",
    });

    const res = await mainnet(
      request(makeApp()).post("/ngn/customers/kyc").send({ customerRef: "u", nin: "12345678901" }),
    );

    expect(res.status).toBe(200);
    expect(submitCustomerKyc).toHaveBeenCalledWith("u", "12345678901");
    // The response is what a client may log. The NIN must not be in it.
    expect(JSON.stringify(res.body)).not.toContain("12345678901");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  // Verification attempts are rate-limited on Linq's side, so an obvious typo
  // is answered here rather than spending one.
  it.each(["1234567890", "123456789012", "1234567890a", ""])(
    "refuses a malformed NIN (%p) without calling Linq",
    async (nin) => {
      const res = await mainnet(
        request(makeApp()).post("/ngn/customers/kyc").send({ customerRef: "u", nin }),
      );
      expect(res.status).toBe(400);
      expect(submitCustomerKyc).not.toHaveBeenCalled();
    },
  );
});

describe("customers", () => {
  it("provisions and reports that an existing customer was reused", async () => {
    (provisionCustomer as jest.Mock).mockResolvedValue({
      customerRef: "u",
      verified: false,
      created: false,
    });

    const res = await mainnet(
      request(makeApp()).post("/ngn/customers").send({
        customerRef: "u",
        firstName: "Ada",
        lastName: "Obi",
        email: "ada@example.com",
        phone: "08012345678",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
  });

  it("requires every field", async () => {
    const res = await mainnet(
      request(makeApp()).post("/ngn/customers").send({ customerRef: "u", firstName: "Ada" }),
    );
    expect(res.status).toBe(400);
    expect(provisionCustomer).not.toHaveBeenCalled();
  });
});

describe("onramp rate", () => {
  // Unlike the offramp's indicative rate, this is the number locked into the
  // order, and XLM floats — so it is never cached.
  it("is never cached", async () => {
    (getOnrampRate as jest.Mock).mockResolvedValue(1356.15);

    const first = await mainnet(request(makeApp()).get("/ngn/onramp/rate"));
    const second = await mainnet(request(makeApp()).get("/ngn/onramp/rate"));

    expect(first.body.rate).toBe(1356.15);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(getOnrampRate).toHaveBeenCalledTimes(2);
    expect(second.status).toBe(200);
  });
});

describe("status lookups require both identifiers", () => {
  // A wallet address is semi-public; an orderId is an unguessable UUID. Linq
  // 404s another customer's order identically to a missing one, so requiring
  // both is what stops an address alone reading someone's bank details.
  it("refuses an onramp lookup without customerRef", async () => {
    const res = await mainnet(request(makeApp()).get("/ngn/onramp/orders/47ca0421"));
    expect(res.status).toBe(400);
    expect(getOnrampStatus).not.toHaveBeenCalled();
  });

  it("refuses a bill lookup without customerRef", async () => {
    const res = await mainnet(request(makeApp()).get("/ngn/bills/9e4b1f2a"));
    expect(res.status).toBe(400);
    expect(getBillStatus).not.toHaveBeenCalled();
  });

  it("passes both through when supplied", async () => {
    (getOnrampStatus as jest.Mock).mockResolvedValue({ orderId: "47ca0421", status: "completed" });

    const res = await mainnet(
      request(makeApp()).get("/ngn/onramp/orders/47ca0421?customerRef=user_789"),
    );

    expect(res.status).toBe(200);
    expect(getOnrampStatus).toHaveBeenCalledWith("user_789", "47ca0421");
  });
});

describe("bills", () => {
  it("creates an airtime order and returns the deposit address", async () => {
    (payBill as jest.Mock).mockResolvedValue({
      id: "9e4b1f2a",
      customerRef: "u",
      wallet: "GDXYZ",
      status: "initiated",
    });

    const res = await mainnet(
      request(makeApp()).post("/ngn/bills").send({
        customerRef: "u",
        billCategory: "airtime",
        provider: "MTN",
        customerId: "08012345678",
        amountNgn: 1000,
        amountStableCoin: 0.75,
        rate: 1333,
        coin: "xlm",
        refundAddress: G_ADDRESS,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe("GDXYZ");
    expect(payBill).toHaveBeenCalledWith(expect.objectContaining({ coin: "xlm", refundAddress: G_ADDRESS }));
  });

  it("refuses an unknown bill category", async () => {
    const res = await mainnet(
      request(makeApp()).post("/ngn/bills").send({
        customerRef: "u",
        billCategory: "crypto-gift-card",
        provider: "MTN",
        customerId: "080",
        amountNgn: 1000,
        amountStableCoin: 0.75,
        rate: 1333,
        coin: "xlm",
        refundAddress: G_ADDRESS,
      }),
    );

    expect(res.status).toBe(400);
    expect(payBill).not.toHaveBeenCalled();
  });

  it("refuses an unknown coin", async () => {
    const res = await mainnet(
      request(makeApp()).post("/ngn/bills").send({
        customerRef: "u",
        billCategory: "airtime",
        provider: "MTN",
        customerId: "080",
        amountNgn: 1000,
        amountStableCoin: 0.75,
        rate: 1333,
        coin: "sui",
        refundAddress: G_ADDRESS,
      }),
    );

    expect(res.status).toBe(400);
    expect(payBill).not.toHaveBeenCalled();
  });
});

describe("orders are recorded, and what is left out of the record", () => {
  it("records an onramp order against the delivery address", async () => {
    (createOnrampOrder as jest.Mock).mockResolvedValue({
      orderId: "47ca0421",
      customerRef: "u",
      accountNumber: "0123456789",
      bankName: "Wema",
      accountName: "Linq",
      amountNgn: 8137,
      amountStableCoin: 6,
      fee: 0,
      expiresAt: "2026-10-02T19:00:00Z",
      status: "initiated",
    });

    const res = await mainnet(
      request(makeApp())
        .post("/ngn/onramp/orders")
        .send({ customerRef: "u", amountStableCoin: 6, walletAddress: G_ADDRESS, rate: 1356, coin: "xlm" }),
    );

    expect(res.status).toBe(200);
    expect(recordNgnOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "onramp",
        orderId: "47ca0421",
        customerRef: "u",
        walletAddress: G_ADDRESS,
        coin: "xlm",
      }),
    );
  });

  // The phone number is personal data under the NDPA. It goes to Linq and
  // stops there — the same rule the NIN follows.
  it("records a bill against the refund address and never the phone number", async () => {
    (payBill as jest.Mock).mockResolvedValue({
      id: "9e4b1f2a",
      customerRef: "u",
      wallet: "GDXYZ",
      status: "initiated",
    });

    await mainnet(
      request(makeApp()).post("/ngn/bills").send({
        customerRef: "u",
        billCategory: "airtime",
        provider: "MTN",
        customerId: "08012345678",
        amountNgn: 1000,
        amountStableCoin: 0.75,
        rate: 1333,
        coin: "xlm",
        refundAddress: G_ADDRESS,
      }),
    );

    const recorded = (recordNgnOrder as jest.Mock).mock.calls.at(-1)?.[0];
    expect(recorded).toMatchObject({
      kind: "bill",
      orderId: "9e4b1f2a",
      walletAddress: G_ADDRESS,
      billCategory: "airtime",
      provider: "MTN",
    });
    expect(JSON.stringify(recorded)).not.toContain("08012345678");
  });
});

describe("falling back to our own record", () => {
  // Linq being down must not look like "your order does not exist".
  it("answers from the record when Linq is unreachable, marked stale", async () => {
    (getBillStatus as jest.Mock).mockRejectedValue(new LinqError("Could not reach Linq", 502));
    (findNgnOrder as jest.Mock).mockResolvedValue({
      orderId: "9e4b1f2a",
      status: "initiated",
      kind: "bill",
      coin: "xlm",
      amountStableCoin: "0.75",
      amountNGN: "1000",
      rate: "1333",
      billCategory: "airtime",
      provider: "MTN",
      settledStableCoin: null,
      settledNGN: null,
      txHash: null,
      updatedAt: new Date("2026-10-02T18:00:00Z"),
    });

    const res = await mainnet(request(makeApp()).get("/ngn/bills/9e4b1f2a?customerRef=u"));

    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.status).toBe("initiated");
  });

  // A 4xx is Linq telling us something true about the request. Papering over it
  // with a stale row would turn "this order is not yours" into a status page.
  it("does not fall back on a 4xx from Linq", async () => {
    (getBillStatus as jest.Mock).mockRejectedValue(new LinqError("Order not found", 404));
    (findNgnOrder as jest.Mock).mockResolvedValue({ orderId: "9e4b1f2a", status: "initiated" });

    const res = await mainnet(request(makeApp()).get("/ngn/bills/9e4b1f2a?customerRef=u"));

    expect(res.status).toBe(404);
    expect(res.body.stale).toBeUndefined();
  });

  it("still fails when Linq is down and we have no record either", async () => {
    (getOnrampStatus as jest.Mock).mockRejectedValue(new LinqError("Could not reach Linq", 502));
    (findNgnOrder as jest.Mock).mockResolvedValue(null);

    const res = await mainnet(request(makeApp()).get("/ngn/onramp/orders/47ca0421?customerRef=u"));

    expect(res.status).toBe(502);
  });
});
