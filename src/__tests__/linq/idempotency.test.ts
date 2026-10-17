/**
 * Which provider calls are safe to repeat, proven against the fake rather than
 * asserted in a comment (W090).
 *
 * Every creating call here is wrapped in `retryOnProviderFailure`, so each one
 * IS repeated whenever Linq answers 5xx or the connection drops. Whether that
 * repeat is harmless depends on the provider recognising it, and the fake in
 * `../fakes/linqProvider.ts` is where what we believe about that is written
 * down. If Linq's behaviour changes, change the fake: these then fail here
 * rather than in production.
 *
 * The case that matters is the dropped response — Linq did the work and the
 * answer never arrived — not the polite duplicate. A duplicate is easy to
 * deduplicate; a dropped response means our retry goes out not knowing whether
 * the first one landed.
 *
 * The retry waits its real 1.5s, so the drop tests take a moment each.
 */
import { createOfframpOrder, LinqError } from "../../linq/client";
import { createOnrampOrder, provisionCustomer } from "../../linq/onramp";
import { payBill } from "../../linq/bills";
import { installFakeLinq, type FakeLinq } from "../fakes/linqProvider";

const DROP = { kind: "drop-after-work" } as const;

// Plainly fake. None of these identify anyone.
const customer = (over: Record<string, string> = {}) => ({
  customerRef: "ref_test_0001",
  firstName: "Test",
  lastName: "Person",
  email: "test.person@example.com",
  phone: "00000000000",
  ...over,
});

const offrampParams = (over: Record<string, unknown> = {}) => ({
  amountStableCoin: 50,
  bankAccount: "0000000000",
  bankCode: "000",
  bankName: "Fake Bank",
  accountName: "Test Person",
  customerRef: "GTESTWALLET",
  idempotencyKey: "idem-key-1",
  ...over,
});

let linq: FakeLinq;

beforeEach(() => {
  process.env.LINQ_API_KEY = "biz_live_test";
  linq = installFakeLinq();
  // Every injected failure is logged by the client, by design. Not this file's subject.
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  // Enforced, not assumed: nothing in this file asked for a path the fake does
  // not implement, and the fake has no way to pass a request on.
  expect(linq.unhandled).toEqual([]);
  linq.restore();
});

describe("provisionCustomer — idempotent on customerRef, by the provider's behaviour", () => {
  it("the same request twice leaves one customer, and the second says it was not created", async () => {
    const first = await provisionCustomer(customer());
    const second = await provisionCustomer(customer());

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(linq.customers.size).toBe(1);
  });

  it("a dropped response is retried into the existing customer, not a second one", async () => {
    linq.failNext("/b2b/customers", DROP);

    const result = await provisionCustomer(customer());

    // Two requests reached Linq and both were "create" — the first one landed,
    // we never heard, and the retry was recognised.
    expect(linq.callsTo("/b2b/customers")).toBe(2);
    expect(linq.customers.size).toBe(1);
    // Worth knowing for anyone reading `created`: after a dropped response the
    // caller is told false for a customer that this very call created.
    expect(result.created).toBe(false);
  });

  it("is keyed on the reference alone, so a retry with different details keeps the first ones", async () => {
    // The weaker half of the guarantee. "Cannot create two customers" holds;
    // "the customer has the details you sent" does not. Correcting an email
    // by provisioning again silently does nothing.
    await provisionCustomer(customer({ email: "first@example.com" }));
    const again = await provisionCustomer(customer({ email: "second@example.com" }));

    expect(again.created).toBe(false);
    expect(linq.customers.size).toBe(1);
    expect(linq.customers.get("ref_test_0001")?.email).toBe("first@example.com");
  });
});

describe("createOfframpOrder — idempotent on idempotencyKey, by the provider's behaviour", () => {
  it("the same key twice is one order with one deposit address", async () => {
    const first = await createOfframpOrder(offrampParams());
    const second = await createOfframpOrder(offrampParams());

    expect(second.id).toBe(first.id);
    expect(second.walletAddress).toBe(first.walletAddress);
    expect(linq.offrampOrders.size).toBe(1);
  });

  it("a dropped response is retried with the same key and recognised as the same order", async () => {
    linq.failNext("/b2b/offramp", DROP);

    const order = await createOfframpOrder(offrampParams());

    expect(linq.callsTo("/b2b/offramp")).toBe(2);
    expect(linq.offrampOrders.size).toBe(1);
    expect(linq.offrampOrders.has(order.id)).toBe(true);
  });

  it("a different key is a different order", async () => {
    await createOfframpOrder(offrampParams({ idempotencyKey: "idem-key-1" }));
    await createOfframpOrder(offrampParams({ idempotencyKey: "idem-key-2" }));

    expect(linq.offrampOrders.size).toBe(2);
  });

  it("a 429 did no work, so the request that follows it creates the only order", async () => {
    // BELIEF, stated in `call()` in linq/client.ts: a rate-limited request was
    // refused before anything was created. Encoded by the fake's `refuse`.
    linq.failNext("/b2b/offramp", {
      kind: "refuse",
      status: 429,
      body: { message: "Rate limit exceeded" },
    });
    global.fetch = withRetryAfterZero(global.fetch);

    await createOfframpOrder(offrampParams());

    expect(linq.callsTo("/b2b/offramp")).toBe(2);
    expect(linq.offrampOrders.size).toBe(1);
  });
});

describe("onramp and bill creation — NOT idempotent, and pinned as such", () => {
  // Both are retried by `retryOnProviderFailure` exactly like the offramp, but
  // neither sends a key and Linq documents none. A retry after a dropped
  // response therefore places a SECOND order. These tests pin that, so the day
  // a key is added the change has to come here and say so.
  //
  // Why it does not move money twice: nothing is paid on creation. The user is
  // shown only the order that answered, and pays into that one; the orphan has
  // no deposit and lapses at `expiresAt`. Its webhook, if any, arrives for an
  // id we never recorded and is logged and ignored.

  it("createOnrampOrder after a dropped response leaves two orders, and returns the second", async () => {
    linq.failNext("/b2b/onramp", DROP);

    const order = await createOnrampOrder({
      customerRef: "ref_test_0001",
      amountStableCoin: 10,
      walletAddress: "GTESTWALLET",
      rate: 1500,
      coin: "usdc",
    });

    expect(linq.onrampOrders.size).toBe(2);
    const [orphan] = [...linq.onrampOrders.keys()];
    expect(order.orderId).not.toBe(orphan);
  });

  it("payBill after a dropped response leaves two orders, and returns the second", async () => {
    linq.failNext("/b2b/bills/pay", DROP);

    const order = await payBill({
      customerRef: "ref_test_0001",
      billCategory: "airtime",
      provider: "MTN",
      customerId: "00000000000",
      amountNgn: 1000,
      amountStableCoin: 0.67,
      rate: 1500,
      coin: "usdc",
      refundAddress: "GTESTWALLET",
    });

    expect(linq.billOrders.size).toBe(2);
    const [orphan] = [...linq.billOrders.keys()];
    expect(order.id).not.toBe(orphan);
  });

  it("a duplicate request is a duplicate order", async () => {
    const params = {
      customerRef: "ref_test_0001",
      amountStableCoin: 10,
      walletAddress: "GTESTWALLET",
      rate: 1500,
      coin: "usdc" as const,
    };
    await createOnrampOrder(params);
    await createOnrampOrder(params);

    expect(linq.onrampOrders.size).toBe(2);
  });
});

describe("what is never retried", () => {
  it("a 4xx is the provider's answer, not a failure, and is not repeated", async () => {
    linq.failNext("/b2b/customers", {
      kind: "refuse",
      status: 400,
      body: { message: "email is invalid", code: "invalid_email" },
    });

    await expect(provisionCustomer(customer())).rejects.toBeInstanceOf(LinqError);
    expect(linq.callsTo("/b2b/customers")).toBe(1);
    expect(linq.customers.size).toBe(0);
  });
});

/** The fake's 429 with `Retry-After: 0`, so the rate-limit wait is not real time. */
function withRetryAfterZero(inner: typeof fetch): typeof fetch {
  return (async (...args: Parameters<typeof fetch>) => {
    const res = await inner(...args);
    if (res.status !== 429) return res;
    const headers = new Headers(res.headers);
    headers.set("Retry-After", "0");
    return new Response(await res.text(), { status: 429, headers });
  }) as typeof fetch;
}
