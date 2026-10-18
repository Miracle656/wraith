import { Router, Request, Response, NextFunction } from "express";
import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

import { prisma } from "../db";
import { requestNetwork } from "../middleware/network";
import { statusForClients } from "../linq/statusForClients";
import {
  bearerToken,
  isOrderId,
  issueOrderCredentials,
  tokenMatches,
} from "../linq/orderAccess";
import {
  LinqError,
  checkStellarTrustline,
  createOfframpOrder,
  getOfframpStatus,
  getRate,
  verifyBank,
} from "../linq/client";

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
 * The payout provider is not named to users.
 *
 * Their own messages are kept, because they explain a rejected account or an
 * amount limit better than a generic line would, but with the provider's name
 * taken out: a user-facing error is the one place it still leaked.
 */
export function withoutProviderName(message: string): string {
  if (/rate.?limit|too many requests/i.test(message)) {
    return "The payout service is busy right now. Try again in a few seconds.";
  }
  if (/wallet generation failed/i.test(message)) {
    // The provider could not mint the order's deposit address: their fault,
    // transient, and meaningless to a user in its own words.
    return "The payout service couldn't set up this order. Try again in a minute.";
  }
  if (/LINQ_API_KEY/i.test(message)) return "Cash-out is not available right now";
  const replaced = message.replace(/linq(?:'s)?/gi, "the payout service");
  return replaced.charAt(0).toUpperCase() + replaced.slice(1);
}

/** Map a LinqError onto the response, preserving their message and status. */
function sendLinqError(res: Response, err: unknown): void {
  if (err instanceof LinqError) {
    // A 5xx from Linq is ours to own as a 502: the caller did nothing wrong.
    const status = err.status >= 500 ? 502 : err.status;
    // See the note in `api/ngn.ts`: the code is the stable half of the answer.
    // It is a provider-neutral identifier, so unlike the message it needs no
    // scrubbing — `withoutProviderName` exists for the prose, not for this.
    res.status(status).json({
      error: withoutProviderName(err.message),
      ...(err.code ? { code: err.code } : {}),
    });
    return;
  }
  res.status(500).json({ error: "Offramp request failed" });
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
    message: { error: "Too many failed order lookups, please try again later." },
  });
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
      res.status(503).json({ error: "Offramp is not configured on this deployment" });
      return;
    }
    next();
  });

  // Every cash-out screen asks for the rate when it opens, and each ask spends
  // the provider allowance all users share. The rate is indicative (the binding
  // one is locked into the order), so a few seconds of reuse costs nothing.
  const RATE_CACHE_MS = 20_000;
  let rateCache: { at: number; body: unknown } | null = null;

  router.get("/rate", async (_req: Request, res: Response) => {
    if (rateCache && Date.now() - rateCache.at < RATE_CACHE_MS) {
      res.json(rateCache.body);
      return;
    }
    try {
      const rate = await getRate();
      // Flagged indicative on purpose: the binding rate is the one locked into
      // an order at creation, and a client that caches this one quotes a
      // number the payout will not honour.
      const body = { ...rate, indicative: true };
      rateCache = { at: Date.now(), body };
      res.json(body);
    } catch (err) {
      sendLinqError(res, err);
    }
  });

  router.post("/verify-bank", async (req: Request, res: Response) => {
    const { bankCode, accountNumber } = req.body ?? {};
    if (typeof bankCode !== "string" || typeof accountNumber !== "string") {
      res.status(400).json({ error: "bankCode and accountNumber are required" });
      return;
    }
    try {
      res.json(await verifyBank(bankCode, accountNumber));
    } catch (err) {
      sendLinqError(res, err);
    }
  });

  router.get("/trustline", async (req: Request, res: Response) => {
    const address = String(req.query.address ?? "");
    if (!address) {
      res.status(400).json({ error: "address is required" });
      return;
    }
    // Worth saying plainly, because it is the mistake this endpoint exists to
    // catch: a Veil wallet address is a CONTRACT (C...), which Linq rejects.
    // The refund address must be the classic fee-payer holding the trustline.
    if (address.startsWith("C")) {
      res.status(400).json({
        error:
          "A contract address cannot receive a refund. Use the classic fee-payer address.",
        valid: false,
        trustsUSDC: false,
      });
      return;
    }
    try {
      res.json(await checkStellarTrustline(address));
    } catch (err) {
      sendLinqError(res, err);
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
      res.status(400).json({
        error:
          "bankAccount, bankCode, bankName, accountName, walletAddress and idempotencyKey are required",
      });
      return;
    }

    try {
      // The key comes from the caller and is never generated here: regenerating
      // it on a retry is precisely how one order becomes two, and the second one
      // also gets paid for.
      const existing = await prisma.offrampOrder.findUnique({
        where: { network_idempotencyKey: { network: net, idempotencyKey } },
      });
      if (existing) {
        // The key alone is not proof of ownership; the wallet that placed the
        // order has to match too, and nothing about the order is said otherwise.
        if (existing.walletAddress !== walletAddress) {
          res.status(409).json({ error: "This idempotencyKey has already been used" });
          return;
        }
        // An idempotency key promises "this key means this request". Replaying it
        // with different figures used to return 200 carrying the FIRST order's
        // amount, rate and deposit address, so a caller that reused a key with a
        // changed amount was told its new payout had been accepted while the money
        // followed the original order. On the only money-moving router here, a
        // silent success for a request nobody made is the worst available outcome.
        //
        // Compared numerically because both sides are decimal strings: "2000" and
        // "2000.00" are the same request and must not 409.
        //
        // PARTIAL, deliberately: the row stores the amounts but not bankAccount,
        // bankCode, bankName or accountName, so a replay that changes only the
        // destination still passes here. Closing that needs a stored hash of the
        // idempotency-relevant fields, which needs a column and a migration —
        // see the note in docs/ rather than guessing at one on a shared database.
        const sameAmount = (stored: string, supplied: unknown): boolean =>
          supplied == null ? false : Number(stored) === Number(supplied);
        const amountMatches =
          amountNGN != null
            ? sameAmount(existing.amountNGN, amountNGN)
            : amountStableCoin != null
              ? sameAmount(existing.amountStableCoin, amountStableCoin)
              : false;
        if (!amountMatches) {
          res.status(409).json({
            error:
              "This idempotencyKey was used for a different request. Use a new key for a new order.",
          });
          return;
        }
        // A retry usually means the first response never arrived, and with it the
        // access token. Only its hash is stored, so a new one is issued and the
        // old one stops working.
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
        return;
      }

      const order = await createOfframpOrder({
        ...(amountNGN != null ? { amountNGN: Number(amountNGN) } : {}),
        ...(amountStableCoin != null
          ? { amountStableCoin: Number(amountStableCoin) }
          : {}),
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
          chain: order.chain ?? "stellar",
          coin: order.coin ?? "usdc",
          depositAddress: order.walletAddress,
          amountStableCoin: String(order.amountStableCoin),
          amountNGN: String(order.amountNGN),
          rate: String(order.rate),
          status: order.status,
        },
      });

      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({ ...order, id: creds.orderId, accessToken: creds.token });
    } catch (err) {
      sendLinqError(res, err);
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
      res.status(401).json({ error: "An order access token is required" });
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
      console.error("[offramp] order lookup failed:", (err as Error)?.name);
      res.status(500).json({ error: "Offramp request failed" });
      return;
    }

    // An id that does not exist and an id the token does not belong to get the
    // same answer, or the difference would list the orders that are real.
    if (!row || !tokenMatches(token, row.accessTokenHash)) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    // Reconciled against the provider rather than served from our row alone. The
    // webhook is a push we might have missed - a sleeping instance, a failed
    // delivery - and a wallet showing "waiting for deposit" against an order
    // that settled twenty minutes ago is worse than a slow answer.
    try {
      const live = await getOfframpStatus(row.orderId);
      if (live.status !== row.status) {
        await prisma.offrampOrder.update({
          where: { network_orderId: { network: net, orderId: row.orderId } },
          data: {
            status: live.status,
            settledStableCoin: String(live.amountStableCoin),
            settledNGN: String(live.amountNGN),
          },
        });
      }
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
