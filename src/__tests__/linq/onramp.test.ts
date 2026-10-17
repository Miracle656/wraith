/**
 * The onramp takes real naira from a real bank account and a person's National
 * Identification Number, with no sandbox to rehearse in. These pin the
 * decisions that are expensive to get wrong and invisible when they are.
 *
 * The NIN tests are the point of this file. They assert a *negative* — that the
 * number appears in exactly one request body and nowhere else — which is the
 * only kind of test that can catch personal data leaking into a log or a
 * persisted shape later.
 */
import {
  assertOnrampNetwork,
  createOnrampOrder,
  getOnrampRate,
  getOnrampStatus,
  provisionCustomer,
  submitCustomerKyc,
} from "../../linq/onramp";
import { LinqError } from "../../linq/client";

const OK = (body: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

const ERR = (status: number, message: string) => ({
  ok: false,
  status,
  text: async () => JSON.stringify({ message }),
});

/** The last fetch call's URL and parsed body. */
function lastCall() {
  const mock = global.fetch as jest.Mock;
  const [url, init] = mock.mock.calls[mock.mock.calls.length - 1];
  return {
    url: String(url),
    init,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  };
}

beforeEach(() => {
  process.env.LINQ_API_KEY = "biz_live_test";
  jest.restoreAllMocks();
});

describe("assertOnrampNetwork", () => {
  it("allows mainnet", () => {
    expect(() => assertOnrampNetwork("mainnet")).not.toThrow();
  });

  // Linq has no sandbox. A `G…` address is valid on both networks, so an order
  // placed from a testnet session takes real naira and delivers real XLM to an
  // address the testnet wallet will never display — paid, and nothing shown.
  it.each(['testnet', 'futurenet', '', 'MAINNET'])('refuses %p', (network) => {
    expect(() => assertOnrampNetwork(network)).toThrow(LinqError);
    try {
      assertOnrampNetwork(network);
    } catch (err) {
      expect((err as LinqError).status).toBe(400);
      expect((err as LinqError).message).toMatch(/only available on mainnet/i);
    }
  });
});

describe("submitCustomerKyc — the NIN never escapes the request", () => {
  const NIN = '12345678901';

  it('sends the NIN once, to the kyc endpoint, and returns nothing containing it', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(OK({ customerRef: 'user_789', verified: true, status: 'verified' })) as never;

    const result = await submitCustomerKyc('user_789', NIN);

    // Exactly one request, and the NIN is in its body.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    const { url, body } = lastCall();
    expect(url).toContain('/b2b/customers/kyc');
    expect(body).toEqual({ customerRef: 'user_789', nin: NIN });

    // And it is absent from everything we hand back. A `nin` field on the
    // result is how it would reach a caller that logs its own responses.
    expect(JSON.stringify(result)).not.toContain(NIN);
    expect(result).not.toHaveProperty('nin');
  });

  it('does not put the NIN in the URL, where it would reach access logs', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(OK({ customerRef: 'user_789', verified: true, status: 'verified' })) as never;

    await submitCustomerKyc('user_789', NIN);

    expect(lastCall().url).not.toContain(NIN);
  });

  it('does not leak the NIN through a thrown error', async () => {
    global.fetch = jest.fn().mockResolvedValue(ERR(422, 'Identity could not be verified')) as never;

    await expect(submitCustomerKyc('user_789', NIN)).rejects.toThrow(LinqError);
    try {
      await submitCustomerKyc('user_789', NIN);
    } catch (err) {
      // Linq's message is useful and is kept; the submitted identity is not
      // part of it, and must not be appended "for context".
      expect((err as Error).message).toBe('Identity could not be verified');
      expect((err as Error).message).not.toContain(NIN);
      expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(NIN);
    }
  });

  it('is not retried, so one identity submission is never replayed', async () => {
    // A verification attempt is rate-limited on Linq's side and touches their
    // identity provider. Replaying it submits the same person twice.
    global.fetch = jest.fn().mockResolvedValue(ERR(429, 'Too many requests')) as never;

    await expect(submitCustomerKyc('user_789', NIN)).rejects.toThrow(LinqError);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });
});

describe("provisionCustomer", () => {
  it('is idempotent — the same customerRef comes back with created:false', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(OK({ customerRef: 'user_789', verified: false, created: false })) as never;

    const result = await provisionCustomer({
      customerRef: 'user_789',
      firstName: 'Ada',
      lastName: 'Obi',
      email: 'ada@example.com',
      phone: '08012345678',
    });

    expect(result.created).toBe(false);
    expect(lastCall().url).toContain('/b2b/customers');
  });

  it('authenticates with the business key, never a consumer token', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(OK({ customerRef: 'u', verified: false, created: true })) as never;

    await provisionCustomer({
      customerRef: 'u',
      firstName: 'A',
      lastName: 'B',
      email: 'a@b.co',
      phone: '080',
    });

    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('biz_live_test');
    expect(headers).not.toHaveProperty('Authorization');
  });

  /**
   * Linq refuses a new reference when the email is already registered, and
   * names the reference it belongs to. Provisioning a second customer for the
   * same person is what locked a tester out: the identity stays bound to the
   * first reference, every later call under a new one is refused, and nothing
   * on our side could see why.
   */
  describe('an email already registered under another reference', () => {
    const ALREADY_IN_USE = {
      ok: false,
      status: 409,
      text: async () =>
        JSON.stringify({
          message: 'This email is already registered under customerRef "veil_etn2674mxqhk"',
          code: 'email_already_in_use',
          customerRef: 'veil_etn2674mxqhk',
        }),
    };

    const PARAMS = {
      customerRef: 'veil_4sjjjzwamdoe',
      firstName: 'Ada',
      lastName: 'Obi',
      email: 'ada@example.com',
      phone: '08012345678',
    };

    it('adopts the reference Linq names instead of failing', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(ALREADY_IN_USE)
        .mockResolvedValueOnce(OK({ customerRef: 'veil_etn2674mxqhk', verified: true })) as never;

      const result = await provisionCustomer(PARAMS);

      expect(result.customerRef).toBe('veil_etn2674mxqhk');
      expect(result.created).toBe(false);
      expect(result.reusedExistingRef).toBe(true);
    });

    // Reporting a verified customer as unverified sends them back through a
    // NIN check that is rate-limited on Linq's side and that they do not need.
    it('reports the adopted reference as verified when it already is', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(ALREADY_IN_USE)
        .mockResolvedValueOnce(OK({ customerRef: 'veil_etn2674mxqhk', verified: true })) as never;

      const result = await provisionCustomer(PARAMS);

      expect(result.verified).toBe(true);
      expect(lastCall().url).toContain('/b2b/customers/status');
      expect(lastCall().url).toContain('veil_etn2674mxqhk');
    });

    // The status lookup is a convenience, not a precondition. If it fails the
    // reference is still the right one to use, and refusing here would strand
    // the person over a field they can refresh later.
    it('still adopts the reference when the status lookup fails', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(ALREADY_IN_USE)
        .mockRejectedValueOnce(new Error('network down')) as never;

      const result = await provisionCustomer(PARAMS);

      expect(result.customerRef).toBe('veil_etn2674mxqhk');
      expect(result.verified).toBe(false);
      expect(result.reusedExistingRef).toBe(true);
    });

    // Inventing a reference is how this went wrong in the first place. With
    // none named there is nothing to adopt, so the error has to surface.
    it('rethrows when Linq names no reference', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(ERR(409, 'This email is already registered')) as never;

      await expect(provisionCustomer(PARAMS)).rejects.toThrow(LinqError);
    });

    // The same reference coming back is the ordinary idempotent case wearing
    // an error's clothes — nothing drifted, so nothing should say it did.
    it('does not flag a reuse when the reference did not change', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: async () =>
          JSON.stringify({
            message: 'already registered',
            code: 'email_already_in_use',
            customerRef: 'veil_4sjjjzwamdoe',
          }),
      }) as never;

      const result = await provisionCustomer(PARAMS);

      expect(result.customerRef).toBe('veil_4sjjjzwamdoe');
      expect(result.reusedExistingRef).toBeUndefined();
    });
  });
});

describe("getOnrampRate", () => {
  // The endpoint returns a bare number, unlike the offramp's /b2b/rate object.
  it('parses a bare number', async () => {
    global.fetch = jest.fn().mockResolvedValue(OK(1356.15)) as never;
    await expect(getOnrampRate()).resolves.toBe(1356.15);
  });

  it('is unauthenticated', async () => {
    global.fetch = jest.fn().mockResolvedValue(OK(1356.15)) as never;
    await getOnrampRate();
    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('X-API-Key');
  });

  // A zero or unparseable rate priced into an order is a wrong amount of naira
  // charged to a real person, so it is refused rather than passed through.
  it.each([0, -1, 'abc', null] as unknown[])('refuses an unusable rate %p', async (value) => {
    global.fetch = jest.fn().mockResolvedValue(OK(value)) as never;
    await expect(getOnrampRate()).rejects.toThrow(/unusable onramp rate/i);
  });
});

describe("createOnrampOrder", () => {
  const base = {
    customerRef: 'user_789',
    amountStableCoin: 6,
    walletAddress: 'GBUO4RL4RTGRFSUDUMRFMC75EWYCRTX5OE3PBIXJVDCZULOXQ2TKDR4Z',
    rate: 1356.15,
  } as const;

  const ORDER = {
    orderId: '47ca0421',
    customerRef: 'user_789',
    accountNumber: '9876543210',
    bankName: 'Wema Bank',
    accountName: 'Linq Onramp Payment',
    amountNgn: 8136.9,
    amountStableCoin: 6,
    fee: 182,
    expiresAt: '2026-10-02T02:38:40Z',
    status: 'awaiting payment',
  };

  // Linq's default chain is Sui and funds sent on the wrong chain are
  // unrecoverable, so the coin→chain mapping is asserted rather than assumed.
  it('maps xlm to { xlm: true }', async () => {
    global.fetch = jest.fn().mockResolvedValue(OK(ORDER)) as never;
    await createOnrampOrder({ ...base, coin: 'xlm' });
    expect(lastCall().body.coin).toEqual({ xlm: true });
  });

  it('maps usdc to { stellar: true }', async () => {
    global.fetch = jest.fn().mockResolvedValue(OK(ORDER)) as never;
    await createOnrampOrder({ ...base, coin: 'usdc' });
    expect(lastCall().body.coin).toEqual({ stellar: true });
  });

  it('always sends currency NGN', async () => {
    global.fetch = jest.fn().mockResolvedValue(OK(ORDER)) as never;
    await createOnrampOrder({ ...base, coin: 'xlm' });
    expect(lastCall().body.currency).toBe('NGN');
  });

  it.each([0, -1])('refuses a non-positive amount (%p) before reaching Linq', async (amount) => {
    global.fetch = jest.fn() as never;
    await expect(createOnrampOrder({ ...base, amountStableCoin: amount, coin: 'xlm' })).rejects.toThrow(
      /greater than zero/i,
    );
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('refuses a non-positive rate before reaching Linq', async () => {
    global.fetch = jest.fn() as never;
    await expect(createOnrampOrder({ ...base, rate: 0, coin: 'xlm' })).rejects.toThrow(
      /greater than zero/i,
    );
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(0);
  });
});

describe("getOnrampStatus", () => {
  // An order belonging to another customer 404s identically to one that does
  // not exist, so a guessed orderId cannot confirm an order exists. Keeping
  // both identifiers required is what preserves that.
  it('sends both customerRef and orderId', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      OK({
        orderId: '47ca0421',
        customerRef: 'user_789',
        status: 'completed',
        amount: 6,
        amountNgn: 8136.9,
        bankName: 'Wema Bank',
        accountNumber: '9876543210',
        accountName: 'Linq Onramp Payment',
      }),
    ) as never;

    await getOnrampStatus('user_789', '47ca0421');

    const { url } = lastCall();
    expect(url).toContain('customerRef=user_789');
    expect(url).toContain('orderId=47ca0421');
  });
});

/**
 * A rejection the user can act on.
 *
 * This client read only `message` and `error`, and threw the whole body away
 * when it was not JSON — so a reason that arrived under any other key reached
 * the KYC screen as the fixed string "Linq rejected the request". The screen
 * then did the only thing left to it and guessed the likeliest cause, telling
 * people to check the spelling of their name. It never parsed `code` either,
 * so every code the API layer forwards on these routes was undefined and the
 * clients were left matching on prose.
 */
describe("call() error parsing", () => {
  const raw = (status: number, body: string) => ({
    ok: false,
    status,
    text: async () => body,
  });

  it.each([
    ["message", { message: "Identity could not be verified" }],
    ["error", { error: "Identity could not be verified" }],
    ["msg", { msg: "Identity could not be verified" }],
    ["detail", { detail: "Identity could not be verified" }],
    ["reason", { reason: "Identity could not be verified" }],
  ])("reads the reason from `%s`", async (_key, body) => {
    global.fetch = jest.fn().mockResolvedValue(raw(422, JSON.stringify(body))) as never;
    await expect(submitCustomerKyc("veil_abc", "12345678901")).rejects.toThrow(
      "Identity could not be verified",
    );
  });

  it.each([["code"], ["errorCode"], ["error_code"]])(
    "carries the machine-readable reason from `%s`",
    async (key) => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(raw(409, JSON.stringify({ message: "no", [key]: "nin_already_used" }))) as never;
      await expect(submitCustomerKyc("veil_abc", "12345678901")).rejects.toMatchObject({
        code: "nin_already_used",
      });
    },
  );

  // The difference between "your NIN is spent" and "check your spelling".
  it("keeps a short plain-text reason rather than replacing it", async () => {
    global.fetch = jest.fn().mockResolvedValue(raw(409, "NIN already used")) as never;
    await expect(submitCustomerKyc("veil_abc", "12345678901")).rejects.toThrow("NIN already used");
  });

  // An HTML error page is a document, not a message — echoing it would put a
  // gateway's markup on a user's screen.
  it("refuses to echo an HTML error page", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(raw(502, "<html><body>502 Bad Gateway</body></html>")) as never;
    await expect(submitCustomerKyc("veil_abc", "12345678901")).rejects.toThrow(
      "Linq rejected the request",
    );
  });

  // Three testers in a row met the bare fallback on a NIN check, which says
  // only that something went wrong — and the screen then guessed a name
  // mismatch each time. A code in the sentence is the difference between
  // diagnosing the next one and asking them to try again.
  it("puts the code in the message when there is no prose", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(raw(422, JSON.stringify({ code: "nin_name_mismatch" }))) as never;
    const err = await submitCustomerKyc("veil_abc", "12345678901").catch((e) => e);
    expect(err.message).toBe("Linq rejected the request (nin_name_mismatch)");
    expect(err.code).toBe("nin_name_mismatch");
  });

  // Prose still wins — it is written for a person, the code is not.
  it("prefers the provider's own words over the code", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        raw(422, JSON.stringify({ message: "Name does not match NIN record", code: "nin_name_mismatch" })),
      ) as never;
    const err = await submitCustomerKyc("veil_abc", "12345678901").catch((e) => e);
    expect(err.message).toBe("Name does not match NIN record");
  });

  it("falls back only when the body names no reason at all", async () => {
    global.fetch = jest.fn().mockResolvedValue(raw(500, JSON.stringify({ ok: false }))) as never;
    const err = await submitCustomerKyc("veil_abc", "12345678901").catch((e) => e);
    expect(err).toBeInstanceOf(LinqError);
    expect(err.message).toBe("Linq rejected the request");
    expect(err.code).toBeUndefined();
  });
});

// ─── Shape tests using the fake ───────────────────────────────────────────────
//
// These tests exercise the full `onramp.ts` call stack against the fake
// provider. The fake is the single source of truth for provider wire shapes:
// correcting it here corrects any test that uses it.
//
// The ad-hoc mocks above test internal error-parsing logic (which key the
// client reads a code from, how it handles HTML bodies, etc.) and must stay.
// These tests verify that the shapes `onramp.ts` sends and reads are the
// documented ones.

import { installFakeLinq, fakeLinq } from "../fakeLinq";

describe("onramp.ts against the fake provider", () => {
  beforeEach(() => {
    process.env.LINQ_API_KEY = "biz_live_test";
    process.env.LINQ_BASE_URL = "https://fake.linq.test";
    installFakeLinq();
  });

  afterAll(() => {
    fakeLinq.restore();
    delete process.env.LINQ_BASE_URL;
  });

  describe("provisionCustomer shapes", () => {
    it("sends the documented fields and reads customerRef/verified/created", async () => {
      const result = await provisionCustomer({
        customerRef: "veil_shape_01",
        firstName: "Ada",
        lastName: "Obi",
        email: "ada.shape@example.com",
        phone: "08012345678",
      });
      expect(result.customerRef).toBe("veil_shape_01");
      expect(result.verified).toBe(false);
      expect(result.created).toBe(true);
    });

    it("is idempotent: second call returns created:false with the same ref", async () => {
      const params = {
        customerRef: "veil_shape_idem",
        firstName: "Ada",
        lastName: "Obi",
        email: "idem.shape@example.com",
        phone: "080",
      };
      await provisionCustomer(params);
      const second = await provisionCustomer(params);
      expect(second.created).toBe(false);
      expect(second.customerRef).toBe("veil_shape_idem");
    });

    it("adopts the reference Linq names when the email is already registered", async () => {
      fakeLinq.seedVerifiedCustomer("veil_existing", "conflict@example.com");

      const result = await provisionCustomer({
        customerRef: "veil_new",
        firstName: "Ada",
        lastName: "Obi",
        email: "conflict@example.com",
        phone: "080",
      });
      expect(result.customerRef).toBe("veil_existing");
      expect(result.reusedExistingRef).toBe(true);
      // The adopted reference is already verified, so it reports that.
      expect(result.verified).toBe(true);
    });
  });

  describe("submitCustomerKyc shapes", () => {
    it("marks the customer verified and returns the documented shape", async () => {
      fakeLinq.seedUnverifiedCustomer("veil_kyc_shape");
      const result = await submitCustomerKyc("veil_kyc_shape", "12345678901");
      expect(result.customerRef).toBe("veil_kyc_shape");
      expect(result.verified).toBe(true);
      expect(result.status).toBe("verified");
    });

    it("forwards nin_already_used as a LinqError with the correct code", async () => {
      fakeLinq.seedUnverifiedCustomer("veil_nin_dup");
      fakeLinq.failNext(
        "POST /b2b/customers/kyc",
        409,
        "nin_already_used",
        "NIN already used",
      );
      const error = await submitCustomerKyc("veil_nin_dup", "11122233344").catch((e) => e);
      expect(error).toBeInstanceOf(LinqError);
      expect(error.code).toBe("nin_already_used");
      expect(error.status).toBe(409);
    });
  });

  describe("getOnrampRate shapes", () => {
    it("parses the bare-number response the provider sends", async () => {
      fakeLinq.setRate(1356.15);
      await expect(getOnrampRate()).resolves.toBeCloseTo(1356.15, 4);
    });
  });

  describe("createOnrampOrder shapes", () => {
    it("returns the bank account details in the documented shape", async () => {
      fakeLinq.seedVerifiedCustomer("veil_order_shape");
      const result = await createOnrampOrder({
        customerRef: "veil_order_shape",
        amountStableCoin: 10,
        walletAddress: "GBUO4RL4RTGRFSUDUMRFMC75EWYCRTX5OE3PBIXJVDCZULOXQ2TKDR4Z",
        rate: 290,
        coin: "xlm",
      });
      expect(result.orderId).toMatch(/^fake-order-/);
      expect(result.accountNumber).toBeTruthy();
      expect(result.bankName).toBeTruthy();
      expect(result.amountNgn).toBeGreaterThan(0);
      expect(result.status).toBe("awaiting payment");
    });

    it("forwards customer_not_verified with the documented code", async () => {
      fakeLinq.seedUnverifiedCustomer("veil_unverified_shape");
      const error = await createOnrampOrder({
        customerRef: "veil_unverified_shape",
        amountStableCoin: 5,
        walletAddress: "GBUO4RL4RTGRFSUDUMRFMC75EWYCRTX5OE3PBIXJVDCZULOXQ2TKDR4Z",
        rate: 290,
        coin: "xlm",
      }).catch((e) => e);
      expect(error).toBeInstanceOf(LinqError);
      expect(error.code).toBe("customer_not_verified");
      expect(error.status).toBe(422);
    });
  });

  describe("getOnrampStatus shapes", () => {
    it("returns the documented status shape for an existing order", async () => {
      fakeLinq.seedVerifiedCustomer("veil_status_shape");
      const order = await createOnrampOrder({
        customerRef: "veil_status_shape",
        amountStableCoin: 6,
        walletAddress: "GBUO4RL4RTGRFSUDUMRFMC75EWYCRTX5OE3PBIXJVDCZULOXQ2TKDR4Z",
        rate: 290,
        coin: "xlm",
      });
      const status = await getOnrampStatus("veil_status_shape", order.orderId);
      expect(status.orderId).toBe(order.orderId);
      expect(status.status).toBe("awaiting payment");
      expect(status.accountNumber).toBe("9876543210");
    });

    it("returns order_not_found for a different customer's order", async () => {
      fakeLinq.seedVerifiedCustomer("veil_owner_shape");
      const order = await createOnrampOrder({
        customerRef: "veil_owner_shape",
        amountStableCoin: 6,
        walletAddress: "GBUO4RL4RTGRFSUDUMRFMC75EWYCRTX5OE3PBIXJVDCZULOXQ2TKDR4Z",
        rate: 290,
        coin: "xlm",
      });
      const error = await getOnrampStatus("veil_thief", order.orderId).catch((e) => e);
      expect(error).toBeInstanceOf(LinqError);
      expect(error.code).toBe("order_not_found");
      expect(error.status).toBe(404);
    });
  });
});
