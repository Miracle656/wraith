/**
 * The naira rails: buying crypto with naira, and paying bills out of the wallet.
 *
 * Both sit behind this service because the Linq API key is the ability to spend
 * — it creates orders that move real naira — and anything in an APK is
 * extractable. The app never holds it.
 *
 * ## The order record, and why it grants no new read access
 *
 * These rails do keep a row (`NgnOrder`), but not for the reason the offramp
 * does. The offramp persists because it mints its own `publicId` and a bearer
 * token so a client can read an order back; `NgnOrder` exists because a bill's
 * outcome is **off-chain**. An onramp delivering XLM lands as a payment the
 * indexer already sees and the address subscription already pushes — no row
 * needed to observe it. A biller refusing to vend after the user has paid is
 * invisible to the chain, so without a row `order.failed` arrives for an order
 * we cannot identify. See `../linq/ngnOrders.ts`.
 *
 * Reads are unchanged by it. Linq's status endpoints require **both**
 * `customerRef` and `orderId`, and return the same 404 for another customer's
 * order as for one that does not exist. `orderId` is an unguessable UUID, so
 * knowing someone's wallet address — which is semi-public — buys nothing on its
 * own. `findNgnOrder` enforces the same pairing locally and returns null for
 * another customer's row, so the local fallback cannot be used to get around it.
 *
 * What we must therefore never add is a route that lists orders by
 * `customerRef` alone, and the table deliberately has no index on that column
 * to keep it from looking cheap. That would turn a public identifier into a way
 * to read someone's bank details and amounts, and it is the one change here
 * that silently removes the protection.
 *
 * ## Mainnet only
 *
 * Linq has no sandbox: every call moves real money. A Stellar `G…` address is
 * valid on both networks, so an order placed from a testnet session would take
 * real naira and deliver real crypto to an address the testnet wallet never
 * displays. `assertOnrampNetwork` refuses that, and these routes apply it
 * before anything else.
 */

import { billStatusForClients } from "../linq/statusForClients";
import { Router, Request, Response, NextFunction } from "express";
import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

import { requestNetwork } from "../middleware/network";
import {
  recordOrderCreated,
  recordOrderTerminal,
  terminalStatusOf,
  type OrderRail,
} from "../metrics";
import { LinqError, getRate as getOfframpNgnPerUsd } from "../linq/client";
import { sendError, sendLinqError } from "./errors";
import { usdPerCoin } from "../linq/coinPrice";
import {
  assertOnrampNetwork,
  createOnrampOrder,
  getOnrampRate,
  getOnrampStatus,
  getCustomerStatus,
  provisionCustomer,
  submitCustomerKyc,
  type OnrampCoin,
} from "../linq/onramp";
import { getBillStatus, listDataBundles, payBill, type BillCategory, type BillCoin } from "../linq/bills";
import { findNgnOrder, recordNgnOrder } from "../linq/ngnOrders";

function isConfigured(): boolean {
  return Boolean(process.env.LINQ_API_KEY?.trim());
}

// Linq's own message names the real problem — an unverified customer, an
// unsupported coin — far better than anything we would invent, so it is passed
// through; `./errors.ts` owns how (and behind which `code`) it reaches the
// client, and a 5xx from the provider is ours to own as a 502: the caller did
// nothing wrong.

/**
 * When Linq itself is unreachable, answer from our own record rather than
 * failing.
 *
 * Only for 502/504 — Linq being down or slow. A 4xx is Linq telling us
 * something true about the request (an unverified customer, an order that does
 * not exist) and must be passed through, not papered over with a stale row.
 *
 * The answer is marked `stale: true` so a client cannot mistake a last-known
 * status for a live one. A bill that was `initiated` when we last heard is not
 * evidence that it still is.
 */
async function fallbackToRecordedOrder(
  res: Response,
  err: unknown,
  network: string,
  customerRef: string,
  orderId: string,
): Promise<boolean> {
  if (!(err instanceof LinqError) || err.status < 500) return false;

  const recorded = await findNgnOrder(network, customerRef, orderId).catch(() => null);
  if (!recorded) return false;

  res.json({ ...recorded, stale: true, reason: "Linq is unreachable; this is our last known status" });
  return true;
}

/**
 * Count a status poll that has just learned an order is finished.
 *
 * The recorded row is read before the provider is asked, so this is a
 * transition counter rather than a poll counter: a wallet polling a completed
 * order does not increment it again. When there is no row (the database is
 * down, or the write after creation was lost), the terminal outcome is still
 * worth knowing and is counted. The row is then refreshed with the new status
 * so the next poll sees the transition as already counted.
 */
async function reconcileTerminalStatus(
  recorded: Awaited<ReturnType<typeof findNgnOrder>>,
  params: {
    network: string;
    customerRef: string;
    rail: OrderRail;
    kind: "onramp" | "bill";
    status: string;
  },
): Promise<void> {
  const terminal = terminalStatusOf(params.status);
  if (!terminal) return;

  // With no stored row there is no previous status, so there is no transition to
  // observe — and nothing to write either, so counting here would count the
  // same ending again on every later poll. orders_terminal_total is documented
  // as a transition counter rather than a poll counter, and a wallet polling a
  // finished order is exactly the case that promise is about.
  if (!recorded) return;
  if (terminalStatusOf(recorded.status)) return;

  recordOrderTerminal(params.rail, terminal);

  await recordNgnOrder({
    network: params.network,
    kind: params.kind,
    orderId: recorded.orderId,
    customerRef: params.customerRef,
    walletAddress: recorded.walletAddress,
    coin: recorded.coin,
    amountStableCoin: recorded.amountStableCoin,
    amountNgn: recorded.amountNGN,
    rate: recorded.rate,
    status: params.status,
    ...(recorded.billCategory ? { billCategory: recorded.billCategory } : {}),
    ...(recorded.provider ? { provider: recorded.provider } : {}),
  });
}

/**
 * Limits how many lookups a client may get **wrong**.
 *
 * `skipSuccessfulRequests` means a wallet polling its own open order every few
 * seconds never spends the budget, while someone trying ids they do not own
 * exhausts it quickly.
 */
/**
 * How far a client's quoted rate may sit from ours before we refuse it.
 *
 * Wide enough that ordinary drift between fetching a rate and posting an order
 * never trips it — XLM floats, and a user may sit on a confirm screen. Narrow
 * enough that the mistake this exists for cannot pass: pricing XLM as a dollar
 * is a factor of roughly five, not a few percent.
 */
const RATE_TOLERANCE = 0.15;

/**
 * Refuse an order whose rate does not match what we would quote.
 *
 * The client sends the rate the order settles at, and for weeks both naira
 * screens sent a dollar rate for XLM orders. Nothing rejected it: the provider
 * honoured what we asked for, and a user bought 0.6 XLM for ₦1,000. A client
 * is allowed to have bugs; it should not be able to move money at a price the
 * server would never quote.
 *
 * Returns true when it has already answered, in the style of the other
 * `reject*` helpers here.
 */
async function rejectMispricedRate(
  res: Response,
  coin: OnrampCoin,
  rate: number,
): Promise<boolean> {
  if (!Number.isFinite(rate) || rate <= 0) {
    sendError(res, 400, "invalid_request", "rate is required");
    return true;
  }

  let expected: number;
  try {
    expected = await ngnPerCoin(coin, "onramp");
  } catch (err) {
    sendLinqError(res, err);
    return true;
  }

  if (Math.abs(rate - expected) / expected > RATE_TOLERANCE) {
    // The number is deliberately not echoed as "use this instead": a client
    // that got the rate wrong should re-fetch it, not be handed one to retry
    // with inside an error path.
    sendError(
      res,
      400,
      "rate_out_of_date",
      "That rate is out of date. Fetch the rate again and retry.",
    );
    return true;
  }
  return false;
}

/**
 * Linq's naira-per-dollar rate, shared by everyone for a short window.
 *
 * Their `/onramprate` is aggressively rate-limited — measured at roughly one
 * fetch per 90 seconds — and we were calling it on every touch of the rails.
 * One person buying once costs six: the availability gate, the markets
 * screen, the buy screen's first read, a coin toggle, the re-read before the
 * order, and the server-side price check. A handful of users at the same time
 * and everyone gets "Rate limit exceeded", which reads as the rails being
 * down.
 *
 * The endpoint above used to say this was deliberately never cached, because
 * the rate is locked into an order and XLM floats. The floating part is true
 * and is handled where it belongs: the XLM price has its own short cache
 * against Horizon, which has no such limit. What is cached here is naira per
 * *dollar*, which moves slowly — and `rejectMispricedRate` tolerates 15%, so
 * a value two minutes old cannot price anything wrongly. An endpoint that
 * answers nothing can.
 */
const NGN_RATE_CACHE_MS = 120_000;

/**
 * Which side of the provider's book a quote comes from.
 *
 * Linq prices the two rails separately and the gap is real money: measured on
 * 2026-10-27, `/onramprate` said 1,478.55 naira to the dollar while a cash-out
 * that settled the same day paid 1,371.58 — 7.2% apart. Buying naira and
 * selling into naira are opposite trades, so there is no single "the rate".
 *
 * This is a required argument rather than one with a default because a default
 * here is the bug it exists to prevent: the offramp quoted the onramp's number
 * for weeks without anything looking wrong, since a plausible rate for the
 * wrong side of the book is indistinguishable from the right one until a payout
 * lands short.
 */
export type RateRail = "onramp" | "offramp";

/** Naira per dollar, straight from the provider, for one side of the book. */
const ngnPerUsdSource: Record<RateRail, () => Promise<number>> = {
  onramp: getOnrampRate,
  // `/b2b/rate` answers with an object; `/onramprate` answers with a bare
  // number. Both are naira per dollar.
  offramp: async () => (await getOfframpNgnPerUsd()).rate,
};

interface NgnRateSlot {
  cache: { rate: number; at: number } | null;
  inFlight: Promise<number> | null;
}

/**
 * One cache per rail. Shared slots would let a buy quote answer a sell request
 * for up to two minutes, which is the same wrong-side error with a timer on it.
 */
const ngnRateSlots: Record<RateRail, NgnRateSlot> = {
  onramp: { cache: null, inFlight: null },
  offramp: { cache: null, inFlight: null },
};

async function ngnPerUsdCached(rail: RateRail): Promise<number> {
  const slot = ngnRateSlots[rail];
  const now = Date.now();
  if (slot.cache && now - slot.cache.at < NGN_RATE_CACHE_MS) return slot.cache.rate;

  // One fetch for a burst, not one per request. Without this a cold cache and
  // five testers opening the app together is five calls to an endpoint that
  // allows one — the exact moment the cache is most needed is the moment it
  // would otherwise be empty for all of them.
  if (slot.inFlight) return slot.inFlight;

  slot.inFlight = ngnPerUsdSource[rail]()
    .then((rate) => {
      slot.cache = { rate, at: Date.now() };
      return rate;
    })
    .finally(() => {
      // Failures are not cached: the next caller should try again rather than
      // inherit an error for two minutes.
      slot.inFlight = null;
    });

  return slot.inFlight;
}

/** Test seam. Production never clears these; the TTL does. */
export function __clearNgnRateCache(): void {
  for (const slot of Object.values(ngnRateSlots)) {
    slot.cache = null;
    slot.inFlight = null;
  }
}

/**
 * Naira per one unit of `coin` — the number a client may divide naira by.
 *
 * Linq gives naira per dollar; this turns it into naira per coin. Every naira
 * amount on both rails is denominated this way, so the conversion happens in
 * exactly one place and the rate we quote is the rate we send Linq.
 *
 * `rail` picks the side of the book and has no default. Getting the *units*
 * right is not the same as getting the *side* right, and the two failures look
 * identical on screen: an earlier fix here correctly stopped dividing naira by
 * a dollar rate for XLM, but routed the offramp through the onramp's price
 * while doing it, so cash-out quoted about 7% above what it paid.
 *
 * Exported so the offramp rate endpoint can reuse the same price path rather
 * than opening a second route to the provider.
 */
export async function ngnPerCoin(coin: OnrampCoin, rail: RateRail): Promise<number> {
  const [ngnPerUsd, usd] = await Promise.all([ngnPerUsdCached(rail), usdPerCoin(coin)]);
  const rate = ngnPerUsd * usd;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new LinqError("Could not price that asset right now", 502, "provider_error");
  }
  return rate;
}

function createLookupLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: 20,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Too many lookups. Wait a minute and try again.",
      code: "veil_rate_limited",
    },
  });
}

/**
 * Per-IP limiter for customer provisioning.
 *
 * Provisioning creates a record at a third-party provider. An abusive caller
 * making many requests with different references burns the provider's own rate
 * limit — the shape the issue calls out: "one abusive caller with many
 * references."
 *
 * Defaults: 10 requests per 10 minutes. Justification: a legitimate user
 * provisions once per lifetime; even accounting for retries and team testing
 * this is generous. Linq's own provisioning endpoint is stateful — a failed
 * retry is free (idempotent), so 10 per 10 minutes is far more than needed.
 *
 * Configurable without a deploy via env vars:
 *   NGN_PROVISION_WINDOW_MS (default: 600_000)
 *   NGN_PROVISION_MAX       (default: 10)
 */
function createProvisionLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: parseInt(process.env.NGN_PROVISION_WINDOW_MS ?? "600000", 10),
    limit: parseInt(process.env.NGN_PROVISION_MAX ?? "10", 10),
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    message: {
      error: "Too many provisioning requests. Please wait before trying again.",
      code: "veil_rate_limited",
    },
  });
}

/**
 * Per-reference limiter for customer provisioning.
 *
 * Catches a single reference being hammered — potentially from different IPs.
 * The per-IP limiter above catches many references from one caller; this one
 * catches one reference from many callers, which is a different attack shape
 * (e.g. a script that rotates proxies to retry the same reference).
 *
 * Defaults: 3 requests per 10 minutes per reference. Justification: a legitimate
 * user provisions once; even a retry after a dropped response is idempotent at
 * Linq, so 3 is enough for flaky networks.
 *
 * Configurable without a deploy via env vars:
 *   NGN_PROVISION_REF_WINDOW_MS (default: 600_000)
 *   NGN_PROVISION_REF_MAX       (default: 3)
 */
function createProvisionRefLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: parseInt(process.env.NGN_PROVISION_REF_WINDOW_MS ?? "600000", 10),
    limit: parseInt(process.env.NGN_PROVISION_REF_MAX ?? "3", 10),
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    keyGenerator: (req: Request) => {
      const ref = (req.body as Record<string, unknown> | undefined)?.customerRef;
      return typeof ref === "string" && ref ? `ref:${ref}` : "ref:_none_";
    },
    message: {
      error: "Too many provisioning requests for this customer. Please wait before trying again.",
      code: "veil_rate_limited",
    },
  });
}

/**
 * Per-IP limiter for KYC submission.
 *
 * A NIN is consumed once. Linq rate-limits KYC on their side, and a burst of
 * KYC attempts from one IP may be a scraper checking NINs against names.
 *
 * Defaults: 5 requests per 30 minutes. Justification: a legitimate user does
 * this once per lifetime; a tester might do it two or three times across
 * multiple accounts in a session, so 5 is enough for a team and still catches
 * automated abuse. Linq allows roughly one attempt every few minutes per
 * reference, so staying under 5 per 30 minutes is comfortably inside their limit.
 *
 * Configurable without a deploy via env vars:
 *   NGN_KYC_WINDOW_MS (default: 1_800_000)
 *   NGN_KYC_MAX       (default: 5)
 */
function createKycLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: parseInt(process.env.NGN_KYC_WINDOW_MS ?? "1800000", 10),
    limit: parseInt(process.env.NGN_KYC_MAX ?? "5", 10),
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    message: {
      error: "Too many identity verification attempts. Please wait before trying again.",
      code: "veil_rate_limited",
    },
  });
}

/**
 * Per-reference limiter for KYC submission.
 *
 * A NIN verification attempt is one-per-lifetime on Linq's side. A per-reference
 * limit prevents one customer's reference being retried many times (which burns
 * the provider's NIMC quota for that identity).
 *
 * Configurable via env vars:
 *   NGN_KYC_REF_WINDOW_MS (default: 1_800_000)
 *   NGN_KYC_REF_MAX       (default: 2)
 */
function createKycRefLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: parseInt(process.env.NGN_KYC_REF_WINDOW_MS ?? "1800000", 10),
    limit: parseInt(process.env.NGN_KYC_REF_MAX ?? "2", 10),
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    keyGenerator: (req: Request) => {
      const ref = (req.body as Record<string, unknown> | undefined)?.customerRef;
      return typeof ref === "string" && ref ? `ref:${ref}` : "ref:_none_";
    },
    message: {
      error: "Too many identity verification attempts for this customer. Please wait before trying again.",
      code: "veil_rate_limited",
    },
  });
}

/**
 * Per-IP limiter for onramp order and bill creation.
 *
 * Creating an order calls a third-party provider and locks a rate. A burst of
 * orders from one IP may be automated and can exhaust the provider's own
 * creation limit.
 *
 * Defaults: 20 requests per 15 minutes. Justification: a typical user places
 * at most a handful of orders in a session; 20 in 15 minutes is enough for
 * legitimate exploratory use while catching scripts. Linq has not published a
 * documented creation rate, but our observations suggest it is around 30–60 per
 * minute — staying at 20 per 15 minutes (roughly 1.3/minute) is well inside it.
 *
 * Configurable without a deploy via env vars:
 *   NGN_ORDERS_WINDOW_MS (default: 900_000)
 *   NGN_ORDERS_MAX       (default: 20)
 */
function createOrdersLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: parseInt(process.env.NGN_ORDERS_WINDOW_MS ?? "900000", 10),
    limit: parseInt(process.env.NGN_ORDERS_MAX ?? "20", 10),
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    message: {
      error: "Too many order requests. Please wait before trying again.",
      code: "veil_rate_limited",
    },
  });
}

/**
 * Per-reference limiter for onramp order and bill creation.
 *
 * Catches one customer reference being used to create many orders in a burst.
 * The per-IP limiter catches an attacker with many references; this catches a
 * single reference being hammered, which protects the user's own account from
 * automated order creation.
 *
 * Configurable via env vars:
 *   NGN_ORDERS_REF_WINDOW_MS (default: 900_000)
 *   NGN_ORDERS_REF_MAX       (default: 5)
 */
function createOrdersRefLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: parseInt(process.env.NGN_ORDERS_REF_WINDOW_MS ?? "900000", 10),
    limit: parseInt(process.env.NGN_ORDERS_REF_MAX ?? "5", 10),
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    keyGenerator: (req: Request) => {
      const ref = (req.body as Record<string, unknown> | undefined)?.customerRef;
      return typeof ref === "string" && ref ? `ref:${ref}` : "ref:_none_";
    },
    message: {
      error: "Too many order requests for this customer. Please wait before trying again.",
      code: "veil_rate_limited",
    },
  });
}

const COINS: Record<string, OnrampCoin> = { xlm: "xlm", usdc: "usdc" };

/**
 * Coins the **onramp** may deliver. XLM only, for now.
 *
 * Linq told us on 2026-10-19 that they hold liquidity to provision XLM and not
 * USDC. The onramp is the one direction where that matters: the customer pays
 * naira and *Linq* delivers the crypto, so a coin they cannot source is an
 * order that takes real money and cannot be filled.
 *
 * Only order creation is gated. `GET /ngn/onramp/rate` deliberately still
 * quotes both, because a quote moves no money and installed APKs probe it with
 * `coin=usdc` to decide whether to show the naira entry point at all —
 * refusing it there would not block a USDC purchase, it would hide the whole
 * naira feature from every user who already has the app.
 *
 * The other two rails are unaffected and also still use `COINS`:
 *   - the offramp sends crypto *to* Linq, so their inventory is irrelevant;
 *   - a bill is funded from the user's own balance, not from Linq's.
 *
 * This is a provider-inventory limit, not a protocol one. When they can source
 * USDC, delete this map and point the order route back at `COINS`.
 */
const ONRAMP_COINS: Record<string, OnrampCoin> = { xlm: "xlm" };
const BILL_CATEGORIES: BillCategory[] = ["airtime", "data", "electricity", "cabletv", "betting"];

/** A classic `G…` account, which is what Linq pays to and refunds to. */
function isClassicAddress(value: unknown): value is string {
  return typeof value === "string" && /^G[A-Z2-7]{55}$/.test(value);
}

/**
 * Both rails address the user by their **classic** account, never the smart
 * wallet contract.
 *
 * Linq pays by classic operation, and a classic payment cannot name a contract
 * as its destination — an exchange or a payroll tool paying a `C…` gets a
 * rejection. The receive screen made exactly this mistake once and the comment
 * there still records it. Getting it wrong on a refund is worse than on a
 * delivery: it fails at the moment the user has already paid and been told
 * their money is coming back.
 */
function rejectContractAddress(res: Response, address: unknown, field: string): boolean {
  if (typeof address === "string" && address.startsWith("C")) {
    sendError(
      res,
      400,
      "invalid_address",
      `${field} must be the classic account, not the smart-wallet contract. Linq pays by classic operation, which cannot name a contract as its destination.`,
    );
    return true;
  }
  if (!isClassicAddress(address)) {
    sendError(res, 400, "invalid_address", `${field} must be a valid Stellar account address`);
    return true;
  }
  return false;
}

export function createNgnRouter(
  options: {
    lookupLimiter?: RateLimitRequestHandler;
    provisionLimiter?: RateLimitRequestHandler;
    provisionRefLimiter?: RateLimitRequestHandler;
    kycLimiter?: RateLimitRequestHandler;
    kycRefLimiter?: RateLimitRequestHandler;
    ordersLimiter?: RateLimitRequestHandler;
    ordersRefLimiter?: RateLimitRequestHandler;
  } = {},
): Router {
  const router = Router();
  const lookupLimiter = options.lookupLimiter ?? createLookupLimiter();
  const provisionLimiter = options.provisionLimiter ?? createProvisionLimiter();
  const provisionRefLimiter = options.provisionRefLimiter ?? createProvisionRefLimiter();
  const kycLimiter = options.kycLimiter ?? createKycLimiter();
  const kycRefLimiter = options.kycRefLimiter ?? createKycRefLimiter();
  const ordersLimiter = options.ordersLimiter ?? createOrdersLimiter();
  const ordersRefLimiter = options.ordersRefLimiter ?? createOrdersRefLimiter();

  // 503 rather than 500 says "this deployment has no naira rails", which is
  // what a client gating a CTA needs to hear, and is true of any build without
  // the secret.
  router.use((_req: Request, res: Response, next: NextFunction) => {
    if (!isConfigured()) {
      sendError(res, 503, "not_configured", "Naira rails are not configured on this deployment");
      return;
    }
    next();
  });

  // Every route here moves real money and Linq has no sandbox.
  router.use((req: Request, res: Response, next: NextFunction) => {
    try {
      assertOnrampNetwork(requestNetwork(req));
      next();
    } catch (err) {
      sendLinqError(res, err);
    }
  });

  // ── Customer provisioning ──────────────────────────────────────────────────

  /**
   * One-time per person, not per order. Safe to call again: Linq returns the
   * existing customer with `created: false`, so a client retrying after a
   * dropped response cannot create two customers for one person. Keyed on
   * `customerRef` alone — a repeat with different details keeps the first
   * ones. See `provisionCustomer` and docs/idempotency.md.
   */
  router.post("/customers", provisionLimiter, provisionRefLimiter, async (req: Request, res: Response) => {
    const { customerRef, firstName, lastName, email, phone } = req.body ?? {};

    if (
      typeof customerRef !== "string" ||
      typeof firstName !== "string" ||
      typeof lastName !== "string" ||
      typeof email !== "string" ||
      typeof phone !== "string"
    ) {
      sendError(
        res,
        400,
        "invalid_request",
        "customerRef, firstName, lastName, email and phone are required",
      );
      return;
    }

    try {
      res.json(await provisionCustomer({ customerRef, firstName, lastName, email, phone }));
    } catch (err) {
      sendLinqError(res, err);
    }
  });

  /**
   * Is this reference verified?
   *
   * Rate-limited like the other lookups: it takes a `customerRef`, and ours
   * are derived from a wallet address, so an unthrottled endpoint answering
   * "does this reference exist and is it verified" is an oracle worth denying.
   *
   * Deliberately a GET with no side effect. The client used to answer this by
   * provisioning a customer, which needed a name, an email and a phone number
   * to ask a yes/no question about a reference it already had.
   */
  router.get("/customers/status", lookupLimiter, async (req: Request, res: Response) => {
    const customerRef = req.query["customerRef"];
    if (typeof customerRef !== "string" || !customerRef) {
      sendError(res, 400, "invalid_request", "customerRef is required");
      return;
    }

    try {
      res.setHeader("Cache-Control", "no-store");
      const status = await getCustomerStatus(customerRef);
      // Three fields by name, never the object Linq handed us.
      //
      // Their reply also carries `firstName` and `lastName`. Forwarding it
      // whole published someone's real name to anyone who could produce their
      // customerRef — and ours are derived from the wallet address, which is
      // semi-public, so that is not a hard thing to produce. A declared
      // interface does not strip anything at runtime; writing the fields out
      // does. The same rule the NIN follows: what we do not pass on cannot
      // leak.
      res.json({
        customerRef: status.customerRef,
        verified: status.verified,
        ...(status.status ? { status: status.status } : {}),
      });
    } catch (err) {
      sendLinqError(res, err);
    }
  });

  /**
   * Verify a customer by NIN.
   *
   * **The NIN is read off the request and handed straight to Linq. It is not
   * logged, not stored, and not echoed back** — see the header of
   * `src/linq/onramp.ts`. Nothing in this handler may add it to a log line or
   * an error body; a NIN is personal data under the NDPA and the cheapest way
   * to hold it correctly is not to hold it.
   */
  router.post("/customers/kyc", kycLimiter, kycRefLimiter, async (req: Request, res: Response) => {
    const { customerRef, nin } = req.body ?? {};

    if (typeof customerRef !== "string" || typeof nin !== "string") {
      sendError(res, 400, "invalid_request", "customerRef and nin are required");
      return;
    }
    // Shape-checked here so an obvious typo is answered without spending a
    // verification attempt, which is rate-limited on Linq's side.
    //
    // It carries the provider's own documented code for the same condition.
    // The clients branch on `invalid_nin_format`, and this check is where that
    // condition is caught almost every time — without the code, the branch the
    // apps wrote for it was unreachable in practice and a typo fell through to
    // their generic 400 copy. Same condition, same code: not a mapping.
    if (!/^\d{11}$/.test(nin)) {
      sendError(res, 400, "invalid_nin_format", "A NIN is 11 digits");
      return;
    }

    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await submitCustomerKyc(customerRef, nin));
    } catch (err) {
      sendLinqError(res, err);
    }
  });

  // ── Onramp: naira in, crypto out ───────────────────────────────────────────

  /**
   * The current rate, uncached.
   *
   * The offramp caches its rate for a few seconds because it is explicitly
   * indicative. This one is not: it is the number locked into the order the
   * user is about to create, and XLM floats. A stale rate here prices someone's
   * order wrong, so every ask is a fresh read.
   */
  router.get("/onramp/rate", async (req: Request, res: Response) => {
    // `coin` is required, and that is the fix.
    //
    // Linq's own rate endpoint accepts a coin and ignores it, handing back the
    // dollar rate regardless — which is how both naira screens ended up
    // pricing XLM as though one XLM were one dollar. Defaulting here would
    // reproduce exactly that: a caller that forgot the coin would get a
    // plausible number that is wrong by a factor of five. Refusing is the only
    // answer that cannot be mistaken for an answer.
    const resolvedCoin = COINS[String(req.query["coin"] ?? "").toLowerCase()];
    if (!resolvedCoin) {
      sendError(res, 400, "invalid_coin", `coin must be one of: ${Object.keys(COINS).join(", ")}`);
      return;
    }

    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ coin: resolvedCoin, rate: await ngnPerCoin(resolvedCoin, "onramp") });
    } catch (err) {
      sendLinqError(res, err);
    }
  });

  router.post("/onramp/orders", ordersLimiter, ordersRefLimiter, async (req: Request, res: Response) => {
    const { customerRef, amountStableCoin, walletAddress, rate, coin } = req.body ?? {};

    if (typeof customerRef !== "string") {
      sendError(res, 400, "invalid_request", "customerRef is required");
      return;
    }
    // The crypto is delivered here, so it must be an address Linq can pay.
    if (rejectContractAddress(res, walletAddress, "walletAddress")) return;

    // Quoting a coin we cannot deliver is worse than refusing it: the customer
    // transfers naira from their own bank app, and an order Linq cannot fill
    // has already taken their money.
    const resolvedCoin = ONRAMP_COINS[String(coin).toLowerCase()];
    if (!resolvedCoin) {
      sendError(
        res,
        400,
        "coin_not_available",
        `coin must be one of: ${Object.keys(ONRAMP_COINS).join(", ")}`,
      );
      return;
    }

    if (await rejectMispricedRate(res, resolvedCoin, Number(rate))) return;

    try {
      res.setHeader("Cache-Control", "no-store");
      const order = await createOnrampOrder({
        customerRef,
        amountStableCoin: Number(amountStableCoin),
        walletAddress,
        rate: Number(rate),
        coin: resolvedCoin,
      });
      recordOrderCreated("onramp");
      res.json(order);

      // After the response, deliberately. The user is holding bank details they
      // need; our bookkeeping must not stand between them and that, and
      // recordNgnOrder never throws.
      void recordNgnOrder({
        network: requestNetwork(req),
        kind: "onramp",
        orderId: order.orderId,
        customerRef,
        walletAddress,
        coin: resolvedCoin,
        amountStableCoin: order.amountStableCoin ?? Number(amountStableCoin),
        amountNgn: order.amountNgn,
        rate: Number(rate),
        status: order.status,
      });
    } catch (err) {
      sendLinqError(res, err);
    }
  });

  // Both identifiers are required, deliberately — see this module's header.
  router.get("/onramp/orders/:orderId", lookupLimiter, async (req: Request, res: Response) => {
    const customerRef = String(req.query.customerRef ?? "");
    if (!customerRef) {
      sendError(res, 400, "invalid_request", "customerRef is required");
      return;
    }

    try {
      res.setHeader("Cache-Control", "no-store");
      const network = requestNetwork(req);
      const [recorded, live] = await Promise.all([
        findNgnOrder(network, customerRef, req.params.orderId as string).catch(() => null),
        getOnrampStatus(customerRef, req.params.orderId as string),
      ]);
      await reconcileTerminalStatus(recorded, {
        network,
        customerRef,
        rail: "onramp",
        kind: "onramp",
        status: live.status,
      });
      res.json(live);
    } catch (err) {
      if (await fallbackToRecordedOrder(res, err, requestNetwork(req), customerRef, req.params.orderId as string)) {
        return;
      }
      sendLinqError(res, err);
    }
  });

  // Data bundles are catalogue items, not arbitrary airtime amounts.
  router.get("/bills/data-bundles", async (req: Request, res: Response) => {
    const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ bundles: listDataBundles(provider) });
  });

  // ── Bills: paid out of the wallet ──────────────────────────────────────────

  router.post("/bills", ordersLimiter, ordersRefLimiter, async (req: Request, res: Response) => {
    const {
      customerRef,
      billCategory,
      provider,
      customerId,
      amountNgn,
      amountStableCoin,
      rate,
      coin,
      refundAddress,
    } = req.body ?? {};

    if (
      typeof customerRef !== "string" ||
      typeof provider !== "string" ||
      typeof customerId !== "string"
    ) {
      sendError(res, 400, "invalid_request", "customerRef, provider and customerId are required");
      return;
    }

    if (!BILL_CATEGORIES.includes(billCategory)) {
      sendError(res, 400, "invalid_request", `billCategory must be one of ${BILL_CATEGORIES.join(", ")}`);
      return;
    }

    const resolvedCoin = COINS[String(coin).toLowerCase()] as BillCoin | undefined;
    if (!resolvedCoin) {
      sendError(res, 400, "invalid_coin", "coin must be xlm or usdc");
      return;
    }

    // Where the deposit returns if the biller rejects the top-up after the user
    // has already paid. A contract here fails at exactly the moment we have
    // promised someone their money is coming back.
    if (rejectContractAddress(res, refundAddress, "refundAddress")) return;

    // The direction that loses the provider money rather than the user: an XLM
    // bill priced as dollars paid about a fifth of the naira it bought.
    if (await rejectMispricedRate(res, resolvedCoin, Number(rate))) return;

    try {
      res.setHeader("Cache-Control", "no-store");
      const order = await payBill({
        customerRef,
        billCategory,
        provider,
        customerId,
        amountNgn: Number(amountNgn),
        amountStableCoin: Number(amountStableCoin),
        rate: Number(rate),
        coin: resolvedCoin,
        refundAddress,
      });
      recordOrderCreated("bills");
      res.json(order);

      // `customerId` — the phone or meter number — is not passed on. It went to
      // Linq and stops there; see the header of linq/ngnOrders.ts.
      void recordNgnOrder({
        network: requestNetwork(req),
        kind: "bill",
        orderId: order.id,
        customerRef,
        walletAddress: refundAddress,
        coin: resolvedCoin,
        amountStableCoin: Number(amountStableCoin),
        amountNgn: Number(amountNgn),
        rate: Number(rate),
        status: order.status,
        billCategory,
        provider,
      });
    } catch (err) {
      sendLinqError(res, err);
    }
  });

  router.get("/bills/:orderId", lookupLimiter, async (req: Request, res: Response) => {
    const customerRef = String(req.query.customerRef ?? "");
    if (!customerRef) {
      sendError(res, 400, "invalid_request", "customerRef is required");
      return;
    }

    try {
      res.setHeader("Cache-Control", "no-store");
      const network = requestNetwork(req);
      const [recorded, live] = await Promise.all([
        findNgnOrder(network, customerRef, req.params.orderId as string).catch(() => null),
        getBillStatus(customerRef, req.params.orderId as string),
      ]);
      await reconcileTerminalStatus(recorded, {
        network,
        customerRef,
        rail: "bills",
        kind: "bill",
        // Reconcile on the provider's own word, never the translated one: the
        // ledger and the metrics record what Linq said.
        status: live.status,
      });
      // Translated for the client, raw value kept alongside it. The bills
      // screen ends on /complete|success|delivered/ and Linq ends a vend as
      // "settled"/"disbursed", so the untranslated value left a delivered
      // top-up spinning forever. See billStatusForClients.
      res.json({ ...live, status: billStatusForClients(live.status), providerStatus: live.status });
    } catch (err) {
      if (await fallbackToRecordedOrder(res, err, requestNetwork(req), customerRef, req.params.orderId as string)) {
        return;
      }
      sendLinqError(res, err);
    }
  });

  return router;
}
