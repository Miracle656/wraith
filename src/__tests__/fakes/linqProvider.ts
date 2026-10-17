/**
 * A fake of Linq, for tests that need the provider to behave like a provider
 * rather than like whatever one test's `mockResolvedValue` imagined.
 *
 * ## Why this exists
 *
 * Linq has no sandbox: every call moves real naira or real personal data. So
 * the only thing a test can run against is a fake, and the fake is where our
 * beliefs about the provider are written down. Each endpoint below implements
 * one belief and says so. When one of them turns out to be wrong, correct it
 * here — the tests that relied on it will then fail, which is the point: they
 * fail in CI instead of in production.
 *
 * This is deliberately small. It covers the creating endpoints whose
 * idempotency the rails depend on (W090). W089 is the issue that grows it into
 * the whole documented surface; extend this file rather than starting another.
 *
 * ## Nothing reaches the real provider
 *
 * `installFakeLinq` replaces `global.fetch` outright. Every request — whatever
 * host it names — is answered here, and a path the fake does not implement gets
 * a 404 and is recorded in `unhandled`, so a test can assert it never strayed.
 * There is no pass-through to the network.
 *
 * ## No personal data
 *
 * The fake implements no KYC endpoint, so it never receives a NIN. It keeps the
 * customer details a provisioning call sends because its behaviour depends on
 * them (the "unchanged" in "returns the existing customer unchanged"); fixtures
 * passed to it should be plainly fake.
 */

import { randomUUID } from "node:crypto";

export interface FakeCustomer {
  customerRef: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  verified: boolean;
}

export interface FakeRequest {
  method: string;
  path: string;
}

type Fault =
  /**
   * Linq does the work, then the response never reaches us — a connection
   * reset, a proxy timeout. The order or customer EXISTS at the provider, and
   * we see only a network failure. This is the case idempotency is for.
   */
  | { kind: "drop-after-work" }
  /** Linq refuses before doing any work, with this status. */
  | { kind: "refuse"; status: number; body: unknown };

export interface FakeLinq {
  readonly customers: Map<string, FakeCustomer>;
  /** Offramp orders, by Linq's order id. */
  readonly offrampOrders: Map<string, Record<string, unknown>>;
  /** Onramp orders, by Linq's order id. */
  readonly onrampOrders: Map<string, Record<string, unknown>>;
  /** Bill orders, by Linq's order id. */
  readonly billOrders: Map<string, Record<string, unknown>>;
  /** Every request that reached the fake, in order. Method and path only. */
  readonly requests: FakeRequest[];
  /** Requests to paths the fake does not implement. Should stay empty. */
  readonly unhandled: FakeRequest[];
  /** Apply `fault` to the next request to `path`, then behave normally. */
  failNext(path: string, fault: Fault): void;
  /** How many requests reached `path`. */
  callsTo(path: string): number;
  /** Put the real `fetch` back. */
  restore(): void;
}

/** NGN per USD the fake quotes. Arbitrary; nothing here asserts on it. */
const FAKE_NGN_PER_USD = 1500;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export function installFakeLinq(): FakeLinq {
  const originalFetch = global.fetch;

  const customers = new Map<string, FakeCustomer>();
  const offrampOrders = new Map<string, Record<string, unknown>>();
  const offrampByKey = new Map<string, string>();
  const onrampOrders = new Map<string, Record<string, unknown>>();
  const billOrders = new Map<string, Record<string, unknown>>();
  const requests: FakeRequest[] = [];
  const unhandled: FakeRequest[] = [];
  const faults = new Map<string, Fault[]>();

  // ── The provider's behaviour, one belief per endpoint ─────────────────────

  const routes: Record<string, (body: any) => Response> = {
    /**
     * BELIEF: provisioning is keyed on `customerRef` alone. A second call with
     * a reference Linq already holds returns that customer **unchanged**, with
     * `created: false` — it neither errors nor updates the stored details.
     *
     * Source: Linq's B2B docs and observed behaviour; restated in the comment
     * on `provisionCustomer`. Not contractually guaranteed to us.
     */
    "POST /b2b/customers": (body) => {
      const existing = customers.get(body.customerRef);
      if (existing) {
        return json(200, {
          customerRef: existing.customerRef,
          verified: existing.verified,
          created: false,
        });
      }
      const customer: FakeCustomer = {
        customerRef: body.customerRef,
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone,
        verified: false,
      };
      customers.set(customer.customerRef, customer);
      return json(200, { customerRef: customer.customerRef, verified: false, created: true });
    },

    /**
     * BELIEF: an offramp order is deduplicated on `idempotencyKey`. A second
     * create carrying a key Linq has already seen returns the ORIGINAL order —
     * same id, same deposit address — and creates nothing.
     *
     * This is the belief the offramp's retry safety rests on whenever our own
     * row does not exist yet (a retry inside `retryOnProviderFailure`, or a
     * client retry after our database write failed). It is NOT confirmed by
     * Linq: their docs accept the field without stating its scope or how long
     * a key is remembered. The fake remembers it forever, which is the most
     * generous reading. See docs/idempotency.md.
     */
    "POST /b2b/offramp": (body) => {
      const seen = offrampByKey.get(body.idempotencyKey);
      if (seen) return json(200, offrampOrders.get(seen));

      const amountStableCoin =
        body.amountStableCoin ?? Number(body.amountNGN) / FAKE_NGN_PER_USD;
      const order = {
        id: randomUUID(),
        walletAddress: `GDEPOSIT${offrampOrders.size}`,
        coinType: "usdc",
        coin: body.coin,
        chain: body.chain,
        amountStableCoin,
        amountNGN: body.amountNGN ?? amountStableCoin * FAKE_NGN_PER_USD,
        rate: FAKE_NGN_PER_USD,
        currency: "NGN",
        status: "initiated",
      };
      offrampOrders.set(order.id, order);
      offrampByKey.set(body.idempotencyKey, order.id);
      return json(200, order);
    },

    /**
     * BELIEF: an onramp order has NO deduplication. We send no key and Linq
     * documents none, so every create is a new order with a new bank account.
     */
    "POST /b2b/onramp": (body) => {
      const order = {
        orderId: randomUUID(),
        customerRef: body.customerRef,
        accountNumber: `00000000${onrampOrders.size}`.slice(-10),
        bankName: "Fake Bank",
        accountName: "Fake Collections",
        amountNgn: body.amountStableCoin * body.rate,
        amountStableCoin: body.amountStableCoin,
        fee: 0,
        expiresAt: "2099-01-01T00:00:00.000Z",
        status: "pending",
      };
      onrampOrders.set(order.orderId, order);
      return json(200, order);
    },

    /** BELIEF: as for the onramp — no key is sent, so no deduplication. */
    "POST /b2b/bills/pay": (body) => {
      const order = {
        id: randomUUID(),
        customerRef: body.customerRef,
        wallet: `GBILLDEPOSIT${billOrders.size}`,
        status: "initiated",
      };
      billOrders.set(order.id, order);
      return json(200, order);
    },
  };

  // ── Transport ─────────────────────────────────────────────────────────────

  const fakeFetch = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init.method ?? "GET").toUpperCase();
    const request = { method, path: url.pathname };
    requests.push(request);

    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) {
      unhandled.push(request);
      return json(404, { message: `The fake does not implement ${method} ${url.pathname}` });
    }

    const fault = faults.get(url.pathname)?.shift();
    if (fault?.kind === "refuse") return json(fault.status, fault.body);

    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : {};
    const response = handler(body);

    if (fault?.kind === "drop-after-work") {
      // The shape undici gives a reset connection. The work above is done and
      // stays done; only the answer is lost.
      throw new TypeError("fetch failed");
    }
    return response;
  };

  global.fetch = fakeFetch as typeof fetch;

  return {
    customers,
    offrampOrders,
    onrampOrders,
    billOrders,
    requests,
    unhandled,
    failNext(path, fault) {
      faults.set(path, [...(faults.get(path) ?? []), fault]);
    },
    callsTo(path) {
      return requests.filter((r) => r.path === path).length;
    },
    restore() {
      global.fetch = originalFetch;
    },
  };
}
