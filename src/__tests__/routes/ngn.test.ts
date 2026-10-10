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

import {
  createOnrampOrder,
  getOnrampRate,
  getOnrampStatus,
  provisionCustomer,
  getCustomerStatus,
  submitCustomerKyc,
} from "../../linq/onramp";
import { getBillStatus, payBill } from "../../linq/bills";
import { findNgnOrder, recordNgnOrder } from "../../linq/ngnOrders";
import { LinqError } from "../../linq/client";
import { usdPerCoin } from "../../linq/coinPrice";
import { __clearNgnRateCache } from "../../api/ngn";

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
  // Shared across requests by design, so it must not leak across tests.
  __clearNgnRateCache();
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

jest.mock("../../linq/coinPrice", () => ({
  usdPerCoin: jest.fn(),
  __clearCoinPriceCache: jest.fn(),
}));

describe("the naira rate is fetched once for everyone", () => {
  // Linq allows roughly one fetch per 90 seconds. One person buying once used
  // to cost six calls, so a few testers at the same time saw "Rate limit
  // exceeded" and read it as the rails being down.
  beforeEach(() => {
    __clearNgnRateCache();
    (getOnrampRate as jest.Mock).mockResolvedValue(1450);
    (usdPerCoin as jest.Mock).mockImplementation(async (c: string) =>
      c === "usdc" ? 1 : 0.2,
    );
  });

  it("serves repeat callers from one fetch", async () => {
    const app = makeApp();
    await mainnet(request(app).get("/ngn/onramp/rate").query({ coin: "usdc" }));
    await mainnet(request(app).get("/ngn/onramp/rate").query({ coin: "xlm" }));
    await mainnet(request(app).get("/ngn/onramp/rate").query({ coin: "usdc" }));
    expect(getOnrampRate).toHaveBeenCalledTimes(1);
  });

  it("collapses a simultaneous burst into one fetch", async () => {
    // The cold-cache case, which is exactly when a group starts testing.
    let release: (v: number) => void = () => undefined;
    (getOnrampRate as jest.Mock).mockReturnValue(
      new Promise<number>((resolve) => {
        release = resolve;
      }),
    );

    const app = makeApp();
    const all = Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        mainnet(request(app).get("/ngn/onramp/rate").query({ coin: "usdc" })),
      ),
    );
    release(1450);
    const results = await all;

    expect(getOnrampRate).toHaveBeenCalledTimes(1);
    for (const res of results) expect(res.body.rate).toBeCloseTo(1450, 6);
  });

  it("does not cache a failure", async () => {
    (getOnrampRate as jest.Mock).mockRejectedValueOnce(new LinqError("down", 502));
    const app = makeApp();
    const first = await mainnet(request(app).get("/ngn/onramp/rate").query({ coin: "usdc" }));
    expect(first.status).toBe(502);

    (getOnrampRate as jest.Mock).mockResolvedValue(1450);
    const second = await mainnet(request(app).get("/ngn/onramp/rate").query({ coin: "usdc" }));
    expect(second.status).toBe(200);
  });
});

describe("the rate is per coin (the ₦1,000-for-0.6-XLM bug)", () => {
  beforeEach(() => {
    (getOnrampRate as jest.Mock).mockResolvedValue(1450);
    (usdPerCoin as jest.Mock).mockImplementation(async (c: string) =>
      c === "usdc" ? 1 : 0.2,
    );
  });

  it("quotes naira per XLM, not naira per dollar", async () => {
    const res = await mainnet(request(makeApp()).get("/ngn/onramp/rate").query({ coin: "xlm" }));
    expect(res.status).toBe(200);
    // 1450 naira to the dollar, 20 cents to the XLM: 290 naira to the XLM.
    // The old answer was 1450, which is what made ₦1,000 buy 0.6 XLM.
    expect(res.body.rate).toBeCloseTo(290, 6);
    expect(res.body.coin).toBe("xlm");
  });

  it("quotes naira per dollar for USDC, which is the same number as before", async () => {
    const res = await mainnet(request(makeApp()).get("/ngn/onramp/rate").query({ coin: "usdc" }));
    expect(res.status).toBe(200);
    expect(res.body.rate).toBeCloseTo(1450, 6);
  });

  // Linq's own endpoint accepts a coin and ignores it, which is how a wrong
  // number looked like a right one for weeks. Ours refuses.
  it("refuses a request with no coin instead of assuming one", async () => {
    const res = await mainnet(request(makeApp()).get("/ngn/onramp/rate"));
    expect(res.status).toBe(400);
  });

  it("refuses an unknown coin", async () => {
    const res = await mainnet(
      request(makeApp()).get("/ngn/onramp/rate").query({ coin: "doge" }),
    );
    expect(res.status).toBe(400);
  });

  it("fails rather than quoting when the asset cannot be priced", async () => {
    (usdPerCoin as jest.Mock).mockRejectedValue(new LinqError("Could not price XLM right now", 502));
    const res = await mainnet(request(makeApp()).get("/ngn/onramp/rate").query({ coin: "xlm" }));
    expect(res.status).toBe(502);
  });
});

describe("the server refuses a mispriced order", () => {
  beforeEach(() => {
    (getOnrampRate as jest.Mock).mockResolvedValue(1450);
    (usdPerCoin as jest.Mock).mockImplementation(async (c: string) =>
      c === "usdc" ? 1 : 0.2,
    );
  });

  const order = (rate: number) => ({
    customerRef: "u",
    amountStableCoin: 1,
    walletAddress: "G" + "A".repeat(55),
    rate,
    coin: "xlm",
  });

  it("rejects the dollar rate sent for an XLM order", async () => {
    const res = await mainnet(request(makeApp()).post("/ngn/onramp/orders").send(order(1450)));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("rate_out_of_date");
    expect(createOnrampOrder).not.toHaveBeenCalled();
  });

  it("accepts the right rate", async () => {
    (createOnrampOrder as jest.Mock).mockResolvedValue({
      orderId: "o1",
      amountNgn: 290,
      status: "pending",
    });
    const res = await mainnet(request(makeApp()).post("/ngn/onramp/orders").send(order(290)));
    expect(res.status).toBe(200);
    expect(createOnrampOrder).toHaveBeenCalled();
  });

  it("tolerates ordinary drift while the user sits on the confirm screen", async () => {
    (createOnrampOrder as jest.Mock).mockResolvedValue({
      orderId: "o1",
      amountNgn: 290,
      status: "pending",
    });
    const res = await mainnet(request(makeApp()).post("/ngn/onramp/orders").send(order(300)));
    expect(res.status).toBe(200);
  });
});

describe("customer status", () => {
  it("answers from the reference alone, creating nothing", async () => {
    (getCustomerStatus as jest.Mock).mockResolvedValue({
      customerRef: "u",
      verified: true,
      status: "verified",
    });

    const res = await mainnet(
      request(makeApp()).get("/ngn/customers/status").query({ customerRef: "u" }),
    );

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(getCustomerStatus).toHaveBeenCalledWith("u");
    // The whole point of this route: asking must not provision anybody.
    expect(provisionCustomer).not.toHaveBeenCalled();
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("requires a customerRef", async () => {
    const res = await mainnet(request(makeApp()).get("/ngn/customers/status"));
    expect(res.status).toBe(400);
    expect(getCustomerStatus).not.toHaveBeenCalled();
  });
});

describe("provider error codes", () => {
  // The client has to tell "this NIN is spent" apart from "this customer is
  // not verified" to say anything true to the user. It used to do that by
  // matching the prose, which breaks the first time the provider rewords an
  // error — so the code is carried through verbatim.
  it("passes the provider code through alongside the message", async () => {
    (submitCustomerKyc as jest.Mock).mockRejectedValue(
      new LinqError("NIN already used", 409, "nin_already_used"),
    );

    const res = await mainnet(
      request(makeApp()).post("/ngn/customers/kyc").send({ customerRef: "u", nin: "12345678901" }),
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("nin_already_used");
    expect(res.body.error).toBe("NIN already used");
  });

  it("omits code entirely when the provider sent none", async () => {
    (submitCustomerKyc as jest.Mock).mockRejectedValue(new LinqError("Something broke", 400));

    const res = await mainnet(
      request(makeApp()).post("/ngn/customers/kyc").send({ customerRef: "u", nin: "12345678901" }),
    );

    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty("code");
    expect(res.body.error).toBe("Something broke");
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
  // This used to assert the opposite — that the upstream rate is fetched on
  // every request, because the number is locked into an order and XLM floats.
  // The floating half is still true and still honoured, just not here: the
  // XLM price is fetched per quote against Horizon. The naira-per-dollar half
  // is now shared briefly, because Linq rate-limits it to about one call per
  // 90 seconds and fetching it six times per purchase took the rails down for
  // concurrent users. See the cache's own tests above.
  it("tells clients never to cache it, whatever we do upstream", async () => {
    (getOnrampRate as jest.Mock).mockResolvedValue(1356.15);
    (usdPerCoin as jest.Mock).mockResolvedValue(1);

    const ask = () => mainnet(request(makeApp()).get("/ngn/onramp/rate").query({ coin: "usdc" }));
    const first = await ask();
    const second = await ask();

    expect(first.body.rate).toBe(1356.15);
    // The one that matters for correctness: a proxy or a client holding this
    // for minutes would price an order against a rate nobody can see.
    expect(first.headers["cache-control"]).toBe("no-store");
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
  // Explicit, not inherited. Jest's `clearMocks` clears calls but leaves
  // implementations in place, so these passed only because a describe above
  // had set them — and would have broken the moment anyone reordered the file.
  beforeEach(() => {
    (getOnrampRate as jest.Mock).mockResolvedValue(1450);
    (usdPerCoin as jest.Mock).mockImplementation(async (c: string) =>
      c === "usdc" ? 1 : 0.2,
    );
  });

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
        rate: 290,
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
        rate: 290,
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
        rate: 290,
        coin: "sui",
        refundAddress: G_ADDRESS,
      }),
    );

    expect(res.status).toBe(400);
    expect(payBill).not.toHaveBeenCalled();
  });
});

describe("orders are recorded, and what is left out of the record", () => {
  // Explicit, not inherited. Jest's `clearMocks` clears calls but leaves
  // implementations in place, so these passed only because a describe above
  // had set them — and would have broken the moment anyone reordered the file.
  beforeEach(() => {
    (getOnrampRate as jest.Mock).mockResolvedValue(1450);
    (usdPerCoin as jest.Mock).mockImplementation(async (c: string) =>
      c === "usdc" ? 1 : 0.2,
    );
  });

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
        .send({ customerRef: "u", amountStableCoin: 6, walletAddress: G_ADDRESS, rate: 290, coin: "xlm" }),
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
        rate: 290,
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
