/**
 * Fake Linq B2B provider.
 *
 * This is the **one place** where the provider's wire shapes are written down.
 * Every suite that needs a Linq-shaped response uses this module; correcting a
 * shape here corrects every test at once.
 *
 * ## What this file is
 *
 * A programmable in-process fake: `global.fetch` is replaced with a function
 * that inspects the URL and body and returns documented responses. Nothing
 * leaves the process. No real naira moves.
 *
 * ## What the provider exposes (all paths under BASE_URL)
 *
 * | Method | Path                   | Purpose                          |
 * |--------|------------------------|----------------------------------|
 * | POST   | /b2b/customers         | Provision a customer             |
 * | GET    | /b2b/customers/status  | Check verification status        |
 * | POST   | /b2b/customers/kyc     | Submit NIN for verification      |
 * | GET    | /onramprate            | Current NGN-per-USD rate         |
 * | POST   | /b2b/onramp            | Create an onramp order           |
 * | GET    | /b2b/onramp/status     | Onramp order status              |
 * | POST   | /b2b/bills/pay         | Create a bill order              |
 * | GET    | /b2b/bills/status      | Bill order status                |
 *
 * ## Documented error codes
 *
 * These are the codes Linq sends that our API layer forwards to clients.
 * The shapes here must match what the real provider sends so tests catch
 * mismatches rather than mask them.
 *
 *  - `email_already_in_use` (409) — customer provisioning
 *  - `nin_already_used` (409) — KYC
 *  - `customer_not_found` (404) — any call that takes a customerRef
 *  - `customer_not_verified` (422) — order creation when KYC is incomplete
 *  - `rate_limited` (429) — any endpoint, with a Retry-After header
 *  - `order_not_found` (404) — status lookups
 *
 * ## Usage
 *
 * ```ts
 * import { installFakeLinq, fakeLinq } from "../fakeLinq";
 *
 * beforeEach(() => installFakeLinq());
 * afterAll(() => fakeLinq.restore());
 *
 * it("...", async () => {
 *   fakeLinq.setRate(1450);
 *   fakeLinq.provisionCustomer("veil_abc");
 *   const result = await provisionCustomer({ customerRef: "veil_abc", ... });
 *   expect(result.customerRef).toBe("veil_abc");
 * });
 * ```
 */

// ─── Wire shapes ─────────────────────────────────────────────────────────────
// These are the exact JSON shapes the provider sends. Change them here and the
// change ripples to every test that uses this module — which is the point.

export interface LinqWireCustomer {
  customerRef: string;
  verified: boolean;
  created: boolean;
}

export interface LinqWireCustomerStatus {
  customerRef: string;
  verified: boolean;
  /** "verified" | "unverified" | "pending" */
  status: string;
  /** Deliberately NOT forwarded by our API — present here so the fake is accurate. */
  firstName: string;
  lastName: string;
}

export interface LinqWireKycResult {
  customerRef: string;
  verified: boolean;
  status: string;
}

export interface LinqWireOnrampOrder {
  orderId: string;
  customerRef: string;
  accountNumber: string;
  bankName: string;
  accountName: string;
  amountNgn: number;
  amountStableCoin: number;
  fee: number;
  expiresAt: string;
  status: string;
}

export interface LinqWireOnrampStatus {
  orderId: string;
  customerRef: string;
  status: string;
  amount: number;
  amountNgn: number;
  bankName: string;
  accountNumber: string;
  accountName: string;
}

export interface LinqWireBillOrder {
  id: string;
  customerRef: string;
  /** The Stellar address the user deposits crypto to. */
  wallet: string;
  status: string;
}

export interface LinqWireBillStatus {
  orderId: string;
  customerRef: string;
  status: string;
  billCategory: string;
  amountNgn: number;
  amountStableCoin: number;
  wallet: string;
  description: string;
  created: string;
  updated: string;
}

export interface LinqWireError {
  message: string;
  code?: string;
  customerRef?: string;
}

// ─── Fake state ───────────────────────────────────────────────────────────────

/** A provisioned customer the fake knows about. */
interface FakeCustomer {
  customerRef: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  verified: boolean;
}

/** An onramp order the fake knows about. */
interface FakeOnrampOrder {
  orderId: string;
  customerRef: string;
  amountStableCoin: number;
  amountNgn: number;
  walletAddress: string;
  status: string;
  accountNumber: string;
  bankName: string;
  accountName: string;
  expiresAt: string;
}

/** A bill order the fake knows about. */
interface FakeBillOrder {
  orderId: string;
  customerRef: string;
  billCategory: string;
  provider: string;
  amountNgn: number;
  amountStableCoin: number;
  status: string;
  wallet: string;
  refundAddress: string;
}

/**
 * The programmable fake. Drives per-endpoint behaviour.
 *
 * Every property is read by the handler for the matching endpoint. `undefined`
 * means "use the built-in happy-path logic". A non-undefined value overrides it
 * for one call.
 */
interface FakeLinqState {
  rate: number;
  customers: Map<string, FakeCustomer>;
  /** email → customerRef, for detecting `email_already_in_use`. */
  emailIndex: Map<string, string>;
  onrampOrders: Map<string, FakeOnrampOrder>;
  billOrders: Map<string, FakeBillOrder>;
  orderSeq: number;
  /**
   * When set, the next call to the named endpoint returns this error instead of
   * the happy path. Consumed (cleared) on use.
   */
  nextErrors: Partial<Record<Endpoint, { status: number; body: LinqWireError; headers?: Record<string, string> }>>;
  /** Counts per endpoint, for asserting call counts. */
  callCounts: Record<string, number>;
}

type Endpoint =
  | "POST /b2b/customers"
  | "GET /b2b/customers/status"
  | "POST /b2b/customers/kyc"
  | "GET /onramprate"
  | "POST /b2b/onramp"
  | "GET /b2b/onramp/status"
  | "POST /b2b/bills/pay"
  | "GET /b2b/bills/status";

// ─── Fake implementation ──────────────────────────────────────────────────────

let state: FakeLinqState = makeInitialState();
let realFetch: typeof global.fetch | undefined;

function makeInitialState(): FakeLinqState {
  return {
    rate: 1450,
    customers: new Map(),
    emailIndex: new Map(),
    onrampOrders: new Map(),
    billOrders: new Map(),
    orderSeq: 1,
    nextErrors: {},
    callCounts: {},
  };
}

function nextOrderId(): string {
  return `fake-order-${String(state.orderSeq++).padStart(4, "0")}`;
}

function ok(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: {
      get: () => null,
    },
    text: async () => text,
  } as unknown as Response;
}

function err(status: number, body: LinqWireError, headers?: Record<string, string>): Response {
  const text = JSON.stringify(body);
  const headerMap: Record<string, string> = headers ?? {};
  return {
    ok: false,
    status,
    headers: {
      get: (name: string) => headerMap[name.toLowerCase()] ?? null,
    },
    text: async () => text,
  } as unknown as Response;
}

function countAndConsumeError(endpoint: Endpoint): Response | null {
  state.callCounts[endpoint] = (state.callCounts[endpoint] ?? 0) + 1;
  const e = state.nextErrors[endpoint];
  if (e) {
    delete state.nextErrors[endpoint];
    return err(e.status, e.body, e.headers);
  }
  return null;
}

function handleRequest(url: string, init: RequestInit | undefined): Response {
  const method = (init?.method ?? "GET").toUpperCase();
  const parsed = new URL(url);
  const path = parsed.pathname;
  const body: Record<string, unknown> = init?.body
    ? (JSON.parse(init.body as string) as Record<string, unknown>)
    : {};

  // ── POST /b2b/customers ──────────────────────────────────────────────────
  if (method === "POST" && path === "/b2b/customers") {
    const forced = countAndConsumeError("POST /b2b/customers");
    if (forced) return forced;

    const { customerRef, firstName, lastName, email, phone } = body as {
      customerRef: string;
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
    };

    // Check if email is already registered under a different ref.
    const existingRef = state.emailIndex.get(email);
    if (existingRef && existingRef !== customerRef) {
      return err(409, {
        message: `This email is already registered under customerRef "${existingRef}"`,
        code: "email_already_in_use",
        customerRef: existingRef,
      });
    }

    const existing = state.customers.get(customerRef);
    if (existing) {
      const wire: LinqWireCustomer = {
        customerRef: existing.customerRef,
        verified: existing.verified,
        created: false,
      };
      return ok(wire);
    }

    const customer: FakeCustomer = {
      customerRef,
      email,
      firstName,
      lastName,
      phone,
      verified: false,
    };
    state.customers.set(customerRef, customer);
    state.emailIndex.set(email, customerRef);

    const wire: LinqWireCustomer = { customerRef, verified: false, created: true };
    return ok(wire);
  }

  // ── GET /b2b/customers/status ────────────────────────────────────────────
  if (method === "GET" && path === "/b2b/customers/status") {
    const forced = countAndConsumeError("GET /b2b/customers/status");
    if (forced) return forced;

    const ref = parsed.searchParams.get("customerRef") ?? "";
    const customer = state.customers.get(ref);
    if (!customer) {
      return err(404, { message: "Customer not found", code: "customer_not_found" });
    }

    const wire: LinqWireCustomerStatus = {
      customerRef: customer.customerRef,
      verified: customer.verified,
      status: customer.verified ? "verified" : "unverified",
      firstName: customer.firstName,
      lastName: customer.lastName,
    };
    return ok(wire);
  }

  // ── POST /b2b/customers/kyc ──────────────────────────────────────────────
  if (method === "POST" && path === "/b2b/customers/kyc") {
    const forced = countAndConsumeError("POST /b2b/customers/kyc");
    if (forced) return forced;

    const { customerRef } = body as { customerRef: string; nin: string };
    const customer = state.customers.get(customerRef);
    if (!customer) {
      return err(404, { message: "Customer not found", code: "customer_not_found" });
    }

    customer.verified = true;
    const wire: LinqWireKycResult = {
      customerRef: customer.customerRef,
      verified: true,
      status: "verified",
    };
    return ok(wire);
  }

  // ── GET /onramprate ──────────────────────────────────────────────────────
  // Returns a BARE NUMBER, not an object — this is the documented shape.
  if (method === "GET" && path === "/onramprate") {
    const forced = countAndConsumeError("GET /onramprate");
    if (forced) return forced;
    // The provider returns a bare number. `JSON.stringify(1450)` → `"1450"`.
    const text = JSON.stringify(state.rate);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => text,
    } as unknown as Response;
  }

  // ── POST /b2b/onramp ─────────────────────────────────────────────────────
  if (method === "POST" && path === "/b2b/onramp") {
    const forced = countAndConsumeError("POST /b2b/onramp");
    if (forced) return forced;

    const { customerRef, amountStableCoin, rate, walletAddress } = body as {
      customerRef: string;
      amountStableCoin: number;
      rate: number;
      walletAddress: string;
    };

    const customer = state.customers.get(customerRef);
    if (!customer) {
      return err(404, { message: "Customer not found", code: "customer_not_found" });
    }
    if (!customer.verified) {
      return err(422, {
        message: "Customer is not verified",
        code: "customer_not_verified",
      });
    }

    const orderId = nextOrderId();
    const amountNgn = Math.round(Number(amountStableCoin) * Number(rate));
    const order: FakeOnrampOrder = {
      orderId,
      customerRef,
      amountStableCoin: Number(amountStableCoin),
      amountNgn,
      walletAddress,
      status: "awaiting payment",
      accountNumber: "9876543210",
      bankName: "Wema Bank",
      accountName: "Linq Onramp Payment",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    state.onrampOrders.set(orderId, order);

    const wire: LinqWireOnrampOrder = {
      orderId: order.orderId,
      customerRef: order.customerRef,
      accountNumber: order.accountNumber,
      bankName: order.bankName,
      accountName: order.accountName,
      amountNgn: order.amountNgn,
      amountStableCoin: order.amountStableCoin,
      fee: Math.round(amountNgn * 0.0125),
      expiresAt: order.expiresAt,
      status: order.status,
    };
    return ok(wire);
  }

  // ── GET /b2b/onramp/status ───────────────────────────────────────────────
  if (method === "GET" && path === "/b2b/onramp/status") {
    const forced = countAndConsumeError("GET /b2b/onramp/status");
    if (forced) return forced;

    const customerRef = parsed.searchParams.get("customerRef") ?? "";
    const orderId = parsed.searchParams.get("orderId") ?? "";
    const order = state.onrampOrders.get(orderId);

    // Linq returns the same 404 for another customer's order as for a missing
    // one — an orderId alone cannot confirm an order exists.
    if (!order || order.customerRef !== customerRef) {
      return err(404, { message: "Order not found", code: "order_not_found" });
    }

    const wire: LinqWireOnrampStatus = {
      orderId: order.orderId,
      customerRef: order.customerRef,
      status: order.status,
      amount: order.amountStableCoin,
      amountNgn: order.amountNgn,
      bankName: order.bankName,
      accountNumber: order.accountNumber,
      accountName: order.accountName,
    };
    return ok(wire);
  }

  // ── POST /b2b/bills/pay ──────────────────────────────────────────────────
  if (method === "POST" && path === "/b2b/bills/pay") {
    const forced = countAndConsumeError("POST /b2b/bills/pay");
    if (forced) return forced;

    const { customerRef, billCategory, provider, amountNgn, amountStableCoin, refundAddress } =
      body as {
        customerRef: string;
        billCategory: string;
        provider: string;
        amountNgn: number;
        amountStableCoin: number;
        refundAddress: string;
      };

    const customer = state.customers.get(customerRef);
    if (!customer) {
      return err(404, { message: "Customer not found", code: "customer_not_found" });
    }
    if (!customer.verified) {
      return err(422, {
        message: "Customer is not verified",
        code: "customer_not_verified",
      });
    }

    const orderId = nextOrderId();
    const billOrder: FakeBillOrder = {
      orderId,
      customerRef,
      billCategory,
      provider,
      amountNgn: Number(amountNgn),
      amountStableCoin: Number(amountStableCoin),
      status: "initiated",
      wallet: "GDEPOSITWALLETADDRESSFORTHEBILATESTHIJKLMNOPQRSTUVWXYZA",
      refundAddress,
    };
    state.billOrders.set(orderId, billOrder);

    const wire: LinqWireBillOrder = {
      id: orderId,
      customerRef,
      wallet: billOrder.wallet,
      status: billOrder.status,
    };
    return ok(wire);
  }

  // ── GET /b2b/bills/status ────────────────────────────────────────────────
  if (method === "GET" && path === "/b2b/bills/status") {
    const forced = countAndConsumeError("GET /b2b/bills/status");
    if (forced) return forced;

    const customerRef = parsed.searchParams.get("customerRef") ?? "";
    const orderId = parsed.searchParams.get("orderId") ?? "";
    const order = state.billOrders.get(orderId);

    if (!order || order.customerRef !== customerRef) {
      return err(404, { message: "Order not found", code: "order_not_found" });
    }

    const wire: LinqWireBillStatus = {
      orderId: order.orderId,
      customerRef: order.customerRef,
      status: order.status,
      billCategory: order.billCategory,
      amountNgn: order.amountNgn,
      amountStableCoin: order.amountStableCoin,
      wallet: order.wallet,
      description: `${order.billCategory} payment ${order.status}`,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    return ok(wire);
  }

  // Anything else is a 404 — the fake only knows about the documented endpoints.
  return err(404, {
    message: `Unknown endpoint: ${method} ${path}`,
    code: "not_found",
  });
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Install the fake and reset all state.
 *
 * Call this in `beforeEach` so every test starts from a clean slate.
 * The fake persists until `fakeLinq.restore()` is called — put that in
 * `afterAll` when used in a describe block that should not bleed into others.
 */
export function installFakeLinq(): void {
  if (!realFetch) {
    realFetch = global.fetch;
  }
  state = makeInitialState();
  global.fetch = jest.fn().mockImplementation(
    (url: string, init?: RequestInit) => Promise.resolve(handleRequest(url, init)),
  ) as unknown as typeof global.fetch;
}

/**
 * The control handle. Use it to prime state before a test and to inspect
 * what the fake saw.
 */
export const fakeLinq = {
  /** Restore `global.fetch` to what it was before `installFakeLinq`. */
  restore(): void {
    if (realFetch) {
      global.fetch = realFetch;
      realFetch = undefined;
    }
    state = makeInitialState();
  },

  /** Seed an already-provisioned, already-verified customer. */
  seedVerifiedCustomer(customerRef: string, email = `${customerRef}@example.com`): void {
    const customer: FakeCustomer = {
      customerRef,
      email,
      firstName: "Ada",
      lastName: "Obi",
      phone: "08012345678",
      verified: true,
    };
    state.customers.set(customerRef, customer);
    state.emailIndex.set(email, customerRef);
  },

  /** Seed an unverified customer (provisioned but KYC not yet done). */
  seedUnverifiedCustomer(customerRef: string, email = `${customerRef}@example.com`): void {
    const customer: FakeCustomer = {
      customerRef,
      email,
      firstName: "Ada",
      lastName: "Obi",
      phone: "08012345678",
      verified: false,
    };
    state.customers.set(customerRef, customer);
    state.emailIndex.set(email, customerRef);
  },

  /**
   * Mark an existing onramp order as settled (simulates the bank transfer
   * arriving and Linq delivering the crypto).
   */
  settleOnrampOrder(orderId: string): void {
    const order = state.onrampOrders.get(orderId);
    if (!order) throw new Error(`fakeLinq.settleOnrampOrder: unknown orderId ${orderId}`);
    order.status = "completed";
  },

  /** Mark an existing bill order as completed. */
  settleBillOrder(orderId: string): void {
    const order = state.billOrders.get(orderId);
    if (!order) throw new Error(`fakeLinq.settleBillOrder: unknown orderId ${orderId}`);
    order.status = "completed";
  },

  /** Set the rate returned by `/onramprate`. */
  setRate(rate: number): void {
    state.rate = rate;
  },

  /**
   * Make the next call to `endpoint` return an error, then revert to normal.
   *
   * Use this to test the one-failure-per-step requirement in issue #246.
   *
   * ```ts
   * fakeLinq.failNext("POST /b2b/customers/kyc", 422, "nin_already_used", "NIN already used");
   * ```
   */
  failNext(
    endpoint: Endpoint,
    status: number,
    code: string,
    message: string,
    headers?: Record<string, string>,
  ): void {
    state.nextErrors[endpoint] = { status, body: { message, code }, headers };
  },

  /**
   * Make the next call to the onramp endpoint return a 429 with a Retry-After
   * header — the documented shape for Linq's rate limit response.
   */
  rateLimitNext(endpoint: Endpoint, retryAfterSeconds = 5): void {
    state.nextErrors[endpoint] = {
      status: 429,
      body: { message: "Rate limit exceeded", code: "rate_limited" },
      headers: { "retry-after": String(retryAfterSeconds) },
    };
  },

  /** How many times `endpoint` has been called since the last `installFakeLinq`. */
  callCount(endpoint: Endpoint): number {
    return state.callCounts[endpoint] ?? 0;
  },

  /** Direct read access to provisioned customers, for assertions. */
  getCustomer(customerRef: string): FakeCustomer | undefined {
    return state.customers.get(customerRef);
  },

  /** Direct read access to placed onramp orders. */
  getOnrampOrder(orderId: string): FakeOnrampOrder | undefined {
    return state.onrampOrders.get(orderId);
  },

  /** Direct read access to placed bill orders. */
  getBillOrder(orderId: string): FakeBillOrder | undefined {
    return state.billOrders.get(orderId);
  },
};
