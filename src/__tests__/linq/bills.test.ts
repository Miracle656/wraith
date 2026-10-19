/**
 * Bills vend real airtime against a real crypto deposit, with no sandbox.
 *
 * The two that matter most here are the `xlm` field shape and the refund
 * address: the first is a documented trap in Linq's API, and the second is only
 * discovered to be missing at the moment a bill fails — which is exactly when
 * the user's money has already left.
 */
import { buildCoinFields, getBillStatus, payBill } from "../../linq/bills";
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

function lastCall() {
  const mock = global.fetch as jest.Mock;
  const [url, init] = mock.mock.calls[mock.mock.calls.length - 1];
  return {
    url: String(url),
    init,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  };
}

const ORDER = {
  id: '9e4b1f2a',
  customerRef: 'user_789',
  wallet: 'GDXYZABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQ',
  status: 'initiated',
};

const base = {
  customerRef: 'user_789',
  billCategory: 'airtime' as const,
  provider: 'MTN',
  customerId: '08012345678',
  amountNgn: 1000,
  amountStableCoin: 0.75,
  rate: 1333.33,
  refundAddress: 'GBUO4RL4RTGRFSUDUMRFMC75EWYCRTX5OE3PBIXJVDCZULOXQ2TKDR4Z',
};

beforeEach(() => {
  process.env.LINQ_API_KEY = 'biz_live_test';
  jest.restoreAllMocks();
});

describe('buildCoinFields — the documented trap', () => {
  it('sets xlm: true for XLM', () => {
    expect(buildCoinFields('xlm')).toEqual({ xlm: true });
  });

  // Linq's docs say to "drop `xlm` entirely rather than setting it to `false`".
  // A literal false is not how this API is told to use USDC, and this endpoint
  // moves money, so the key must be absent rather than falsy.
  it('omits xlm entirely for USDC rather than sending false', () => {
    const fields = buildCoinFields('usdc');
    expect(fields).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(fields, 'xlm')).toBe(false);
  });
});

describe('payBill', () => {
  it('sends xlm: true for an XLM-funded bill', async () => {
    global.fetch = jest.fn().mockResolvedValue(OK(ORDER)) as never;
    await payBill({ ...base, coin: 'xlm' });
    expect(lastCall().body.xlm).toBe(true);
  });

  it('sends no xlm key at all for a USDC-funded bill', async () => {
    global.fetch = jest.fn().mockResolvedValue(OK(ORDER)) as never;
    await payBill({ ...base, coin: 'usdc' });
    expect(Object.prototype.hasOwnProperty.call(lastCall().body, 'xlm')).toBe(false);
  });

  it('passes the biller fields through unchanged', async () => {
    global.fetch = jest.fn().mockResolvedValue(OK(ORDER)) as never;
    await payBill({ ...base, coin: 'xlm' });

    const { url, body } = lastCall();
    expect(url).toContain('/b2b/bills/pay');
    expect(body).toMatchObject({
      customerRef: 'user_789',
      billCategory: 'airtime',
      provider: 'MTN',
      customerId: '08012345678',
      amountNgn: 1000,
      amountStableCoin: 0.75,
      rate: 1333.33,
      refundAddress: base.refundAddress,
    });
  });

  // Only discovered when a bill fails, which is after the user has paid — so
  // it is refused here rather than at the provider.
  it('refuses a missing refundAddress before reaching Linq', async () => {
    global.fetch = jest.fn() as never;
    await expect(payBill({ ...base, refundAddress: '', coin: 'xlm' })).rejects.toThrow(
      /refundAddress is required/i,
    );
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(0);
  });

  it.each([
    ['amountNgn', { amountNgn: 0 }],
    ['amountStableCoin', { amountStableCoin: 0 }],
    ['rate', { rate: 0 }],
  ])('refuses a non-positive %s before reaching Linq', async (_label, override) => {
    global.fetch = jest.fn() as never;
    await expect(payBill({ ...base, ...override, coin: 'xlm' })).rejects.toThrow(
      /greater than zero/i,
    );
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('authenticates with the business key, never a consumer token', async () => {
    global.fetch = jest.fn().mockResolvedValue(OK(ORDER)) as never;
    await payBill({ ...base, coin: 'xlm' });
    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('biz_live_test');
    expect(headers).not.toHaveProperty('Authorization');
  });

  it("surfaces Linq's own message, which names the real problem", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(ERR(400, 'Customer is not verified')) as never;

    await expect(payBill({ ...base, coin: 'xlm' })).rejects.toThrow('Customer is not verified');
  });
});

describe('getBillStatus', () => {
  // Another customer's order 404s identically to one that does not exist, so a
  // guessed orderId cannot confirm an order exists. Requiring both preserves it.
  it('sends both customerRef and orderId', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      OK({
        orderId: '9e4b1f2a',
        customerRef: 'user_789',
        status: 'completed',
        billCategory: 'airtime',
        amountNgn: 1000,
        amountStableCoin: 0.75,
        wallet: ORDER.wallet,
        description: 'Bill payment completed successfully',
        created: '2026-10-02T01:30:00Z',
        updated: '2026-10-02T01:31:40Z',
      }),
    ) as never;

    await getBillStatus('user_789', '9e4b1f2a');

    const { url } = lastCall();
    expect(url).toContain('customerRef=user_789');
    expect(url).toContain('orderId=9e4b1f2a');
  });
});
