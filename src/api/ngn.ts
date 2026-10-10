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

import { Router, Request, Response, NextFunction } from "express";
import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

import { requestNetwork } from "../middleware/network";
import { LinqError } from "../linq/client";
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
import { getBillStatus, payBill, type BillCategory, type BillCoin } from "../linq/bills";
import { findNgnOrder, recordNgnOrder } from "../linq/ngnOrders";

function isConfigured(): boolean {
  return Boolean(process.env.LINQ_API_KEY?.trim());
}

/**
 * Linq's own message names the real problem — an unverified customer, an
 * unsupported coin — far better than anything we would invent, so it is passed
 * through. A 5xx from them is ours to own as a 502: the caller did nothing
 * wrong.
 */
function sendLinqError(res: Response, err: unknown): void {
  if (err instanceof LinqError) {
    // `code` rides along when Linq sent one — `nin_already_used`,
    // `customer_not_verified`, and so on. Without it the clients are left
    // matching on the prose in `error`, which is how a reworded provider
    // message turns into a user sent down the wrong branch. `error` stays
    // exactly as it was, so nothing that reads it today breaks.
    res.status(err.status >= 500 ? 502 : err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
    return;
  }
  res.status(500).json({ error: "Request failed" });
}

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
    res.status(400).json({ error: "rate is required" });
    return true;
  }

  let expected: number;
  try {
    expected = await ngnPerCoin(coin);
  } catch (err) {
    sendLinqError(res, err);
    return true;
  }

  if (Math.abs(rate - expected) / expected > RATE_TOLERANCE) {
    // The number is deliberately not echoed as "use this instead": a client
    // that got the rate wrong should re-fetch it, not be handed one to retry
    // with inside an error path.
    res.status(400).json({
      error: "That rate is out of date. Fetch the rate again and retry.",
      code: "rate_out_of_date",
    });
    return true;
  }
  return false;
}

/**
 * Naira per one unit of `coin` — the number a client may divide naira by.
 *
 * Linq gives naira per dollar; this turns it into naira per coin. Every naira
 * amount on both rails is denominated this way, so the conversion happens in
 * exactly one place and the rate we quote is the rate we send Linq.
 */
async function ngnPerCoin(coin: OnrampCoin): Promise<number> {
  const [ngnPerUsd, usd] = await Promise.all([getOnrampRate(), usdPerCoin(coin)]);
  const rate = ngnPerUsd * usd;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new LinqError("Could not price that asset right now", 502);
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
    message: { error: "Too many lookups. Wait a minute and try again." },
  });
}

const COINS: Record<string, OnrampCoin> = { xlm: "xlm", usdc: "usdc" };
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
    res.status(400).json({
      error: `${field} must be the classic account, not the smart-wallet contract. Linq pays by classic operation, which cannot name a contract as its destination.`,
    });
    return true;
  }
  if (!isClassicAddress(address)) {
    res.status(400).json({ error: `${field} must be a valid Stellar account address` });
    return true;
  }
  return false;
}

export function createNgnRouter(
  options: { lookupLimiter?: RateLimitRequestHandler } = {},
): Router {
  const router = Router();
  const lookupLimiter = options.lookupLimiter ?? createLookupLimiter();

  // 503 rather than 500 says "this deployment has no naira rails", which is
  // what a client gating a CTA needs to hear, and is true of any build without
  // the secret.
  router.use((_req: Request, res: Response, next: NextFunction) => {
    if (!isConfigured()) {
      res.status(503).json({ error: "Naira rails are not configured on this deployment" });
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
   * dropped response cannot create two customers for one person.
   */
  router.post("/customers", async (req: Request, res: Response) => {
    const { customerRef, firstName, lastName, email, phone } = req.body ?? {};

    if (
      typeof customerRef !== "string" ||
      typeof firstName !== "string" ||
      typeof lastName !== "string" ||
      typeof email !== "string" ||
      typeof phone !== "string"
    ) {
      res.status(400).json({
        error: "customerRef, firstName, lastName, email and phone are required",
      });
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
      res.status(400).json({ error: "customerRef is required" });
      return;
    }

    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await getCustomerStatus(customerRef));
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
  router.post("/customers/kyc", async (req: Request, res: Response) => {
    const { customerRef, nin } = req.body ?? {};

    if (typeof customerRef !== "string" || typeof nin !== "string") {
      res.status(400).json({ error: "customerRef and nin are required" });
      return;
    }
    // Shape-checked here so an obvious typo is answered without spending a
    // verification attempt, which is rate-limited on Linq's side.
    if (!/^\d{11}$/.test(nin)) {
      res.status(400).json({ error: "A NIN is 11 digits" });
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
      res.status(400).json({ error: `coin must be one of: ${Object.keys(COINS).join(", ")}` });
      return;
    }

    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ coin: resolvedCoin, rate: await ngnPerCoin(resolvedCoin) });
    } catch (err) {
      sendLinqError(res, err);
    }
  });

  router.post("/onramp/orders", async (req: Request, res: Response) => {
    const { customerRef, amountStableCoin, walletAddress, rate, coin } = req.body ?? {};

    if (typeof customerRef !== "string") {
      res.status(400).json({ error: "customerRef is required" });
      return;
    }
    // The crypto is delivered here, so it must be an address Linq can pay.
    if (rejectContractAddress(res, walletAddress, "walletAddress")) return;

    const resolvedCoin = COINS[String(coin).toLowerCase()];
    if (!resolvedCoin) {
      res.status(400).json({ error: "coin must be xlm or usdc" });
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
      res.status(400).json({ error: "customerRef is required" });
      return;
    }

    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await getOnrampStatus(customerRef, req.params.orderId));
    } catch (err) {
      if (await fallbackToRecordedOrder(res, err, requestNetwork(req), customerRef, req.params.orderId)) {
        return;
      }
      sendLinqError(res, err);
    }
  });

  // ── Bills: paid out of the wallet ──────────────────────────────────────────

  router.post("/bills", async (req: Request, res: Response) => {
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
      res.status(400).json({ error: "customerRef, provider and customerId are required" });
      return;
    }

    if (!BILL_CATEGORIES.includes(billCategory)) {
      res.status(400).json({ error: `billCategory must be one of ${BILL_CATEGORIES.join(", ")}` });
      return;
    }

    const resolvedCoin = COINS[String(coin).toLowerCase()] as BillCoin | undefined;
    if (!resolvedCoin) {
      res.status(400).json({ error: "coin must be xlm or usdc" });
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
      res.status(400).json({ error: "customerRef is required" });
      return;
    }

    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await getBillStatus(customerRef, req.params.orderId));
    } catch (err) {
      if (await fallbackToRecordedOrder(res, err, requestNetwork(req), customerRef, req.params.orderId)) {
        return;
      }
      sendLinqError(res, err);
    }
  });

  return router;
}
