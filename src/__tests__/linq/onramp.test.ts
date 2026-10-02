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
