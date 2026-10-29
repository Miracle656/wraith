import { createHmac } from "crypto";
import { Router, Request, Response, NextFunction } from "express";
import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { OfframpOrder } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../db";
import { requestNetwork } from "../middleware/network";
import { recordOrderCreated, recordOrderTerminal, terminalStatusOf } from "../metrics";
import { statusForClients } from "../linq/statusForClients";
import {
  bearerToken,
  isOrderId,
  issueOrderCredentials,
  tokenMatches,
} from "../linq/orderAccess";import {
  checkStellarTrustline,
  createOfframpOrder,
  getOfframpStatus,
  verifyBank,
} from "../linq/client";
import { isFailureStatus, recordMoneyFailure } from "../linq/moneyFailures";
import { ngnPerCoin } from "./ngn";
import { sendError, sendLinqError } from "./errors";
import { type OnrampCoin } from "../linq/onramp";

// Re-exported so existing imports of the scrubber from this module keep
// working; its home is now `./errors.ts`, where the shared error writer lives.
export { withoutProviderName } from "./errors";

/**
 * Offramp router - mounts at /offramp
 *
 * A thin surface in front of Linq. It exists because the Linq API key creates
 * orders that pay real naira to real bank accounts, so it stays server-side
 * and the wallet talks to these routes instead.
 *
 * Not proxied: anything that mutates the business account (signup, key
 * rotation). Those are operator actions and have no business behind a route
 * the wallet can reach.
 */

function isConfigured(): boolean {
  return !!process.env.LINQ_API_KEY?.trim();
}

/**
 * This rail's `sendLinqError`: the shared writer with the provider's name
 * taken out of every message and this rail's own fallback text.
 */
function sendLinqErrorScoped(res: Response, err: unknown): void {
  sendLinqError(res, err, {
    scrubMessage: true,
    fallbackMessage: "Offramp request failed",
  });
}

/**
 * The most one order may move, per currency. A naira ceiling is meaningless as a
 * stablecoin one, so each has its own; both can be set in the environment. A value
 * that is not a positive finite number is ignored rather than trusted: a typo in
 * config must not turn into a bound of NaN that rejects every amount.
 */
const DEFAULT_MAX_AMOUNT_NGN = 10_000_000;
const DEFAULT_MAX_AMOUNT_STABLECOIN = 10_000;

function amountCeiling(envName: string, fallback: number): number {
  const parsed = Number(process.env[envName]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * An amount arrives as a JSON number or a decimal string. Anything else is
 * refused rather than coerced: `Number("abc")` is NaN, `Number(true)` is 1 and
 * `Number([5])` is 5, none of which is an amount somebody meant to send.
 */
function amountSchema(max: number) {
  return z
    .union([z.number(), z.string().trim().regex(/^\d+(\.\d+)?$/)])
    .transform(Number)
    .pipe(z.number().positive().max(max));
}

/**
 * Keyed hash of what an idempotency key was used to ask for.
 *
 * The key alone only says "this is the same attempt"; this says "and it asked for
 * the same thing". Amounts are normalised numerically so "50" and "50.00" match.
 * HMAC with the provider key, which is never stored beside the row, because a
 * plain hash of a ten-digit account number can be reversed by trying them all.
 *
 * Returns null rather than minting without a key. `createHmac` accepts an empty
 * one, and an HMAC keyed with "" is a plain hash anyone can recompute, which is
 * exactly the reversal described above. The router's `isConfigured` gate makes
 * that unreachable today; this keeps it unreachable if the gate ever moves.
 */
export function requestFingerprint(r: {
  amountNGN?: unknown;
  amountStableCoin?: unknown;
  bankAccount: string;
  bankCode: string;
  accountName: string;
  refundAddress: unknown;
  walletAddress: string;
}): string | null {
  const key = process.env.LINQ_API_KEY;
  // Checked trimmed, as `isConfigured` does, but the key itself is used as-is:
  // trimming it would change every fingerprint already stored.
  if (!key?.trim()) return null;
  const amount = (v: unknown) => (v == null ? "" : String(Number(v)));
  return createHmac("sha256", key)
    .update(
      JSON.stringify([
        amount(r.amountNGN),
        amount(r.amountStableCoin),
        r.bankAccount,
        r.bankCode,
        r.accountName,
        typeof r.refundAddress === "string" ? r.refundAddress : "",
        r.walletAddress,
      ]),
    )
    .digest("hex");
}

/** True for Prisma's unique-constraint violation, without depending on its class. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

/**
 * Answers a request whose idempotency key already has an order.
 *
 * Shared by the up-front lookup and by the insert that loses a race, so a
 * concurrent duplicate gets exactly the checks a sequential one does: it is not
 * a way round the wallet or request comparison, and it hands back our id and a
 * fresh token, never the provider's id.
 */
async function replayOrder(
  res: Response,
  existing: OfframpOrder,
  request: {
    walletAddress: string;
    amountNGN?: unknown;
    amountStableCoin?: unknown;
    requestHash: string;
  },
): Promise<void> {
  // The key alone is not proof of ownership; the wallet that placed the order
  // has to match too, and nothing about the order is said otherwise.
  if (existing.walletAddress !== request.walletAddress) {
    sendError(res, 409, "idempotency_conflict", "This idempotencyKey has already been used");
    return;
  }
  // An idempotency key promises "this key means this request". Replaying it with
  // different figures used to return 200 carrying the FIRST order's amount, rate
  // and deposit address, so a caller that reused a key with a changed amount was
  // told its new payout had been accepted while the money followed the original
  // order. On the only money-moving router here, a silent success for a request
  // nobody made is the worst available outcome.
  //
  // Compared numerically because both sides are decimal strings: "2000" and
  // "2000.00" are the same request and must not 409.
  const sameAmount = (stored: string, supplied: unknown): boolean =>
    supplied == null ? false : Number(stored) === Number(supplied);
  const amountMatches =
    request.amountNGN != null
      ? sameAmount(existing.amountNGN, request.amountNGN)
      : request.amountStableCoin != null
        ? sameAmount(existing.amountStableCoin, request.amountStableCoin)
        : false;
  if (!amountMatches) {
    sendError(
      res,
      409,
      "idempotency_conflict",
      "This idempotencyKey was used for a different request. Use a new key for a new order.",
    );
    return;
  }
  // The amounts above are all the row stores of its own accord, so a replay that
  // changed only the destination used to pass. The stored fingerprint covers the
  // rest. A row without one predates it and can only be held to the amount.
  if (existing.requestHash != null && existing.requestHash !== request.requestHash) {
    sendError(
      res,
      409,
      "idempotency_conflict",
      "This idempotencyKey was used with different order details",
    );
    return;
  }
  // A retry usually means the first response never arrived, and with it the
  // access token. Only its hash is stored, so a new one is issued and the old
  // one stops working.
  const creds = issueOrderCredentials(existing.publicId ?? undefined);
  await prisma.offrampOrder.update({
    where: { id: existing.id },
    data: { publicId: creds.orderId, accessTokenHash: creds.tokenHash },
  });
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    id: creds.orderId,
    accessToken: creds.token,
    walletAddress: existing.depositAddress,
    chain: existing.chain,
    coin: existing.coin,
    amountStableCoin: Number(existing.amountStableCoin),
    amountNGN: Number(existing.amountNGN),
    rate: Number(existing.rate),
    status: statusForClients(existing.status),
    providerStatus: existing.status,
    replayed: true,
  });
}

/**
 * Limits how many lookups a client may get wrong.
 *
 * Only failed requests count (`skipSuccessfulRequests`), so a wallet polling its
 * own order every few seconds never spends the budget, while someone trying ids
 * or tokens runs out after a handful of misses. Separate from the app-wide
 * limiter, which is far too generous for a credential check and is switched off
 * under test.
 */
export function createOrderLookupLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: parseInt(process.env.OFFRAMP_LOOKUP_WINDOW_MS ?? "900000", 10),
    limit: parseInt(process.env.OFFRAMP_LOOKUP_MAX_FAILURES ?? "10", 10),
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Too many failed order lookups, please try again later.",
      code: "veil_rate_limited",
    },
  });
}

/**
 * The coin a coin-less rate request is priced for.
 *
 * A USDC is a dollar, so `ngnPerCoin("usdc")` is naira-per-dollar — the number
 * `/offramp/rate` returned before `coin` existed. Defaulting to it changes
 * nothing for the caller that omits the param; see the rollout note in the
 * `/rate` handler for why refusing it is the wrong order of operations.
 */
const LEGACY_DEFAULT_COIN: OnrampCoin = "usdc";

// One line per caller, not one per request: every cash-out screen reload is a
// request, and a log that floods is a log nobody reads. The key is what a client
// sends as its User-Agent, which is enough to tell "the old APK" from "the web
// wallet forgot the param" — and it is not personal data, unlike an IP. This
// does not need to know *who* is asking, only whether anyone still is, and when
// they stop.
const legacyCoinCallers = new Set<string>();

function logCoinlessRateRequest(req: Request): void {
  const caller = req.get("user-agent") || "(no User-Agent)";
  if (legacyCoinCallers.has(caller)) return;
  legacyCoinCallers.add(caller);
  console.warn(
    `[offramp] deprecated: GET /offramp/rate without coin from "${caller}" — priced for ` +
      `${LEGACY_DEFAULT_COIN}. Sending coin will be required once every installed build does.`,
  );
}

/** Test seam: the deprecation log fires once per caller for the process. */
export function __resetCoinlessRateLog(): void {
  legacyCoinCallers.clear();
}

export function createOfframpRouter(
  options: { lookupLimiter?: RateLimitRequestHandler } = {},
): Router {
  const router = Router();
  const lookupLimiter = options.lookupLimiter ?? createOrderLookupLimiter();

  // Every route needs the key. Answering 503 rather than 500 says "this
  // deployment has no offramp", which is what a client gating a CTA needs to
  // hear, and is true of any build without the secret.
  router.use((_req: Request, res: Response, next: NextFunction) => {
    if (!isConfigured()) {
      sendError(res, 503, "not_configured", "Offramp is not configured on this deployment");
      return;
    }
    next();
  });

  /**
   * Is cash-out switched on in this deployment?
   *
   * This exists so the availability gate has an endpoint that answers the
   * question it is actually asking. `isOfframpAvailable()` used to call
   * `/offramp/rate` and read any error as "no cash-out", which made a pricing
   * endpoint the health check for a feature — so a change to the rate contract
   * was an outage for every build that gated on it, and a coin-less rate request
   * was the most reliable way to ask "is the service up".
   *
   * It deliberately does not contact the provider. Every rate read spends from
   * an allowance all users share, and a gate that runs when an app opens — on
   * every install, several times a day — is the worst possible place to spend
   * it. "Is the provider reachable right now" is not this question, and cannot
   * be answered cheaply: creating an order is what discovers that, and it
   * reports the failure itself.
   *
   * The `available: true` body is not decoration. A client that only looked at
   * the status would treat a redirect, an HTML error page from a proxy, or a
   * captive portal as cash-out being up; a body it has to parse does not.
   */
  router.get("/availability", (_req: Request, res: Response) => {
    // no-store: this is the answer a client gates a CTA on, and a cached 200
    // from before a rollback would keep offering cash-out that 503s on every
    // other route.
    res.setHeader("Cache-Control", "no-store");
    res.json({ available: true });
  });

  // `coin` is the answer's subject, so the response always names it — that is
  // what lets a client tell which asset it was quoted for instead of assuming.
  //
  // A request with **no** coin is still answered, with the USDC rate, for one
  // reason: installed APKs. `isOfframpAvailable()` in the mobile client treats
  // any error here as "cash-out is down" and hides the tile, so a 400 on the
  // coin-less request does not ask anyone to pick a coin — it removes the
  // feature for every user on an old build until they happen to update, and
  // looks like an outage. #216 was this same mistake and the recorded lesson is
  // ship the client first.
  //
  // Answering is not the silent defaulting the onramp refuses. `ngnPerCoin` for
  // USDC *is* naira-per-dollar (a USDC is a dollar, and `usdPerCoin` returns 1
  // without looking at a book), so a coin-less caller gets back exactly the
  // number it gets today — correct for USDC, wrong for XLM, and already wrong
  // in both clients. Refusing does not make an old APK price XLM correctly; it
  // only stops it pricing at all.
  //
  // So this is a staged removal, not a decision to keep the default:
  //   1. now  - unknown coin 400s; missing coin answers as USDC and logs.
  //   2. next - both clients send `coin`, and the availability check moves to
  //             `GET /offramp/availability` above instead of borrowing this
  //             endpoint. veil#1124. Stage 3 is what those clients unblock.
  //   3. then - once an APK carrying step 2 is actually out and
  //             `logCoinlessRateRequest` has gone quiet, a missing coin 400s and
  //             this comment becomes the onramp's.
  const COINS: Record<string, OnrampCoin> = { xlm: "xlm", usdc: "usdc" };

  // The rate is computed by ngnPerCoin, which multiplies a NGN/USD rate by the
  // coin's USD price. The `"offramp"` rail is load-bearing: it reads Linq's
  // `/b2b/rate`, the sell side, rather than `/onramprate`, the buy side. Those
  // are different numbers — 1,371.58 against 1,478.55 on 2026-10-27 — and this
  // endpoint quoting the buy side is what made every cash-out promise about 7%
  // more naira than the payout delivered, all the way to the receipt.
  //
  // Per-coin cache: every cash-out screen asks for the rate when it opens, and
  // each ask spends the provider allowance all users share.  The rate here is
  // indicative (the binding one is locked into the order), so a few seconds of
  // reuse costs nothing.  Coins are cached separately so an XLM quote does not
  // evict a USDC quote that arrived a moment before.
  const RATE_CACHE_MS = 20_000;
  const rateCacheByCoins = new Map<OnrampCoin, { at: number; body: unknown }>();

  router.get("/rate", async (req: Request, res: Response) => {
    // An absent `coin` is a build too old to send one, so it is answered the way
    // it already reads the answer. A `coin` that is present but does not resolve
    // — `doge`, an empty value left behind by a client that lost the variable, a
    // repeated parameter — is a caller bug, and a plausible number for the wrong
    // asset is the one outcome this endpoint exists to refuse. Values are
    // lowercased and trimmed, so `XLM` is not read as unknown.
    const supplied = req.query["coin"];
    const resolvedCoin =
      supplied === undefined
        ? LEGACY_DEFAULT_COIN
        : COINS[String(supplied).trim().toLowerCase()];

    if (!resolvedCoin) {
      sendError(res, 400, "invalid_coin", `coin must be one of: ${Object.keys(COINS).join(", ")}`);
      return;
    }
    if (supplied === undefined) logCoinlessRateRequest(req);

    const cached = rateCacheByCoins.get(resolvedCoin);
    if (cached && Date.now() - cached.at < RATE_CACHE_MS) {
      res.json(cached.body);
      return;
    }

    try {
      const rate = await ngnPerCoin(resolvedCoin, "offramp");
      // Flagged indicative on purpose: the binding rate is the one locked into
      // an order at creation, and a client that caches this one quotes a
      // number the payout will not honour.
      const body = { coin: resolvedCoin, rate, indicative: true };
      rateCacheByCoins.set(resolvedCoin, { at: Date.now(), body });
      res.json(body);
    } catch (err) {
      sendLinqErrorScoped(res, err);
    }
  });

  router.post("/verify-bank", async (req: Request, res: Response) => {
    const { bankCode, accountNumber } = req.body ?? {};
    if (typeof bankCode !== "string" || typeof accountNumber !== "string") {
      sendError(res, 400, "invalid_request", "bankCode and accountNumber are required");
      return;
    }
    try {
      res.json(await verifyBank(bankCode, accountNumber));
    } catch (err) {
      sendLinqErrorScoped(res, err);
    }
  });

  router.get("/trustline", async (req: Request, res: Response) => {
    const address = String(req.query.address ?? "");
    if (!address) {
      sendError(res, 400, "invalid_request", "address is required");
      return;
    }
    // Worth saying plainly, because it is the mistake this endpoint exists to
    // catch: a Veil wallet address is a CONTRACT (C...), which Linq rejects.
    // The refund address must be the classic fee-payer holding the trustline.
    if (address.startsWith("C")) {
      sendError(
        res,
        400,
        "invalid_address",
        "A contract address cannot receive a refund. Use the classic fee-payer address.",
        { valid: false, trustsUSDC: false },
      );
      return;
    }
    try {
      res.json(await checkStellarTrustline(address));
    } catch (err) {
      sendLinqErrorScoped(res, err);
    }
  });

  router.post("/orders", async (req: Request, res: Response) => {
    const net = requestNetwork(req);
    const {
      amountNGN,
      amountStableCoin,
      bankAccount,
      bankCode,
      bankName,
      accountName,
      refundAddress,
      walletAddress,
      idempotencyKey,
    } = req.body ?? {};

    if (
      typeof bankAccount !== "string" ||
      typeof bankCode !== "string" ||
      typeof bankName !== "string" ||
      typeof accountName !== "string" ||
      typeof walletAddress !== "string" ||
      typeof idempotencyKey !== "string"
    ) {
      sendError(
        res,
        400,
        "invalid_request",
        "bankAccount, bankCode, bankName, accountName, walletAddress and idempotencyKey are required",
      );
      return;
    }

    // Checked before the idempotency lookup and before anything reaches the
    // provider: `Number("abc")` is NaN and `Number` also accepts negatives and
    // Infinity, and none of those should be able to start a payout.
    if (amountNGN == null && amountStableCoin == null) {
      sendError(res, 400, "invalid_request", "amountNGN or amountStableCoin is required");
      return;
    }
    const parsedAmounts: { amountNGN?: number; amountStableCoin?: number } = {};
    if (amountNGN != null) {
      const max = amountCeiling("OFFRAMP_MAX_AMOUNT_NGN", DEFAULT_MAX_AMOUNT_NGN);
      const parsed = amountSchema(max).safeParse(amountNGN);
      if (!parsed.success) {
        sendError(
          res,
          400,
          "invalid_request",
          `amountNGN must be a positive number no greater than ${max}`,
        );
        return;
      }
      parsedAmounts.amountNGN = parsed.data;
    }
    if (amountStableCoin != null) {
      const max = amountCeiling(
        "OFFRAMP_MAX_AMOUNT_STABLECOIN",
        DEFAULT_MAX_AMOUNT_STABLECOIN,
      );
      const parsed = amountSchema(max).safeParse(amountStableCoin);
      if (!parsed.success) {
        sendError(
          res,
          400,
          "invalid_request",
          `amountStableCoin must be a positive number no greater than ${max}`,
        );
        return;
      }
      parsedAmounts.amountStableCoin = parsed.data;
    }

    const requestHash = requestFingerprint({
      ...parsedAmounts,
      bankAccount,
      bankCode,
      accountName,
      refundAddress,
      walletAddress,
    });
    if (requestHash === null) {
      res.status(503).json({ error: "Offramp is not configured on this deployment" });
      return;
    }
    const replayOf = { walletAddress, ...parsedAmounts, requestHash };

    try {
      // The key comes from the caller and is never generated here: regenerating
      // it on a retry is precisely how one order becomes two, and the second one
      // also gets paid for.
      //
      // Scope: one key per network, enforced by @@unique([network,
      // idempotencyKey]). Lifetime: as long as the row, and rows are never
      // deleted, so a key is spent for good. Full write-up in
      // docs/idempotency.md.
      //
      // This check only covers orders we have RECORDED. Two cases get past it
      // and are held to one order by Linq deduplicating on the key instead —
      // a belief about the provider, encoded in the fake and pinned in
      // __tests__/routes/idempotency.test.ts:
      //  - Linq created the order but our insert below failed, and the client
      //    retried. No row, so the retry goes back to Linq with the same key.
      //  - Two identical requests in flight together. Both miss here; the
      //    unique index refuses the second insert, and that caller gets a 500
      //    for an order that exists. Retrying then replays it.
      const existing = await prisma.offrampOrder.findUnique({
        where: { network_idempotencyKey: { network: net, idempotencyKey } },
      });
      if (existing) {
        await replayOrder(res, existing, replayOf);
        return;
      }

      const order = await createOfframpOrder({
        ...parsedAmounts,
        bankAccount,
        bankCode,
        bankName,
        accountName,
        ...(typeof refundAddress === "string" ? { refundAddress } : {}),
        customerRef: walletAddress,
        idempotencyKey,
      });

      // The provider's id never leaves the server: the client is given our own,
      // and a token that proves it created the order.
      const creds = issueOrderCredentials();

      // Persisted before responding. A row that only exists after the client
      // has been told the deposit address is a row that can be missing while
      // the user is already sending funds against it.
      await prisma.offrampOrder.create({
        data: {
          network: net,
          orderId: order.id,
          publicId: creds.orderId,
          accessTokenHash: creds.tokenHash,
          idempotencyKey,
          walletAddress,
          requestHash,
          chain: order.chain ?? "stellar",
          coin: order.coin ?? "usdc",
          depositAddress: order.walletAddress,
          amountStableCoin: String(order.amountStableCoin),
          amountNGN: String(order.amountNGN),
          rate: String(order.rate),
          status: order.status,
        },
      });

      recordOrderCreated("offramp");

      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({ ...order, id: creds.orderId, accessToken: creds.token });
    } catch (err) {
      // Two taps of the same request both miss the lookup above; the provider
      // dedupes them to one order, and the second insert then trips
      // @@unique([network, idempotencyKey]). The order exists and is fine, so the
      // loser is answered as the replay it is instead of with a 500.
      if (isUniqueViolation(err)) {
        try {
          const winner = await prisma.offrampOrder.findUnique({
            where: { network_idempotencyKey: { network: net, idempotencyKey } },
          });
          if (winner) {
            await replayOrder(res, winner, replayOf);
            return;
          }
        } catch {
          // Nothing of the database failure is passed on; fall through.
        }
      }
      if (!res.headersSent) sendLinqErrorScoped(res, err);
    }
  });

  router.get("/orders/:orderId", lookupLimiter, async (req: Request, res: Response) => {
    const net = requestNetwork(req);
    const { orderId } = req.params;
    res.setHeader("Cache-Control", "no-store");

    // No credential at all is the one refusal that says so. It is the same for
    // every id, so it tells a caller nothing about which ones exist.
    const token = bearerToken(req);
    if (!token) {
      res.setHeader("WWW-Authenticate", "Bearer");
      sendError(res, 401, "unauthorized", "An order access token is required");
      return;
    }

    let row;
    try {
      row = isOrderId(orderId)
        ? await prisma.offrampOrder.findUnique({
            where: { network_publicId: { network: net, publicId: orderId } },
          })
        : null;
    } catch (err) {
      // Logged by name only: nothing of the database failure is passed on.
      console.error("[offramp] order lookup failed:", (err as Error)?.name);
      sendError(res, 500, "internal_error", "Offramp request failed");
      return;
    }

    // An id that does not exist and an id the token does not belong to get the
    // same answer, or the difference would list the orders that are real.
    if (!row || !tokenMatches(token, row.accessTokenHash)) {
      sendError(res, 404, "order_not_found", "Order not found");
      return;
    }

    // Reconciled against the provider rather than served from our row alone. The
    // webhook is a push we might have missed - a sleeping instance, a failed
    // delivery - and a wallet showing "waiting for deposit" against an order
    // that settled twenty minutes ago is worse than a slow answer.
    try {
      const live = await getOfframpStatus(row.orderId);
      const wasTerminal = terminalStatusOf(row.status);
      const isTerminal = terminalStatusOf(live.status);
      if (live.status !== row.status) {
        await prisma.offrampOrder.update({
          where: { network_orderId: { network: net, orderId: row.orderId } },
          data: {
            status: live.status,
            settledStableCoin: String(live.amountStableCoin),
            settledNGN: String(live.amountNGN),
          },
        });

        // The webhook is a push we might have missed, and this poll is what
        // catches one up — including the case that matters most. An order that
        // ended failed means the user's crypto was taken and the naira payout
        // did not complete; if the `order.failed` delivery never arrived, this
        // poll is the only thing that ever learns it. Recorded under the same
        // (network, kind, orderId) row the webhook path uses, so when both
        // fire it is one incident, not two.
        if (isFailureStatus(live.status)) {
          await recordMoneyFailure({
            network: net,
            rail: "offramp",
            kind: "payout_rejected",
            orderId: row.orderId,
            publicId: row.publicId,
            providerCode: live.status,
            message: `Offramp order ended as "${live.status}" — the naira payout did not complete.`,
          });
        }
      }
      if (isTerminal && !wasTerminal) recordOrderTerminal("offramp", live.status);
      res.json({
        ...live,
        id: row.publicId,
        status: statusForClients(live.status),
        providerStatus: live.status,
        depositAddress: row.depositAddress,
        // The rate and the creation time live in our row, not in the provider's
        // status. Without them a wallet that reopens an order in flight shows
        // "₦0 / USDC" and a countdown with no start, which reads as expired.
        rate: Number(row.rate),
        createdAt: row.createdAt.toISOString(),
        source: "live",
      });
    } catch {
      // Provider unreachable: our row is stale but true as of the last update, and
      // saying so beats failing the request outright. Nothing of the upstream
      // failure is passed on.
      res.json({
        id: row.publicId,
        status: statusForClients(row.status),
        providerStatus: row.status,
        amountStableCoin: Number(row.settledStableCoin ?? row.amountStableCoin),
        amountNGN: Number(row.settledNGN ?? row.amountNGN),
        depositAddress: row.depositAddress,
        rate: Number(row.rate),
        createdAt: row.createdAt.toISOString(),
        source: "cache",
      });
    }
  });

  return router;
}
