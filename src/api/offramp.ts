import { Router, Request, Response, NextFunction } from "express";

import { prisma } from "../db";
import { requestNetwork } from "../middleware/network";
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

/** Map a LinqError onto the response, preserving their message and status. */
function sendLinqError(res: Response, err: unknown): void {
  if (err instanceof LinqError) {
    // A 5xx from Linq is ours to own as a 502: the caller did nothing wrong.
    const status = err.status >= 500 ? 502 : err.status;
    res.status(status).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: "Offramp request failed" });
}

export function createOfframpRouter(): Router {
  const router = Router();

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

  router.get("/rate", async (_req: Request, res: Response) => {
    try {
      const rate = await getRate();
      // Flagged indicative on purpose: the binding rate is the one locked into
      // an order at creation, and a client that caches this one quotes a
      // number the payout will not honour.
      res.json({ ...rate, indicative: true });
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

    // The key comes from the caller and is never generated here: regenerating
    // it on a retry is precisely how one order becomes two, and the second one
    // also gets paid for.
    const existing = await prisma.offrampOrder.findUnique({
      where: { network_idempotencyKey: { network: net, idempotencyKey } },
    });
    if (existing) {
      res.status(200).json({
        id: existing.orderId,
        walletAddress: existing.depositAddress,
        chain: existing.chain,
        coin: existing.coin,
        amountStableCoin: Number(existing.amountStableCoin),
        amountNGN: Number(existing.amountNGN),
        rate: Number(existing.rate),
        status: existing.status,
        replayed: true,
      });
      return;
    }

    try {
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

      // Persisted before responding. A row that only exists after the client
      // has been told the deposit address is a row that can be missing while
      // the user is already sending funds against it.
      await prisma.offrampOrder.create({
        data: {
          network: net,
          orderId: order.id,
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

      res.status(201).json(order);
    } catch (err) {
      sendLinqError(res, err);
    }
  });

  router.get("/orders/:orderId", async (req: Request, res: Response) => {
    const net = requestNetwork(req);
    const { orderId } = req.params;

    const row = await prisma.offrampOrder.findUnique({
      where: { network_orderId: { network: net, orderId } },
    });
    if (!row) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    // Reconciled against Linq rather than served from our row alone. The
    // webhook is a push we might have missed - a sleeping instance, a failed
    // delivery - and a wallet showing "waiting for deposit" against an order
    // that settled twenty minutes ago is worse than a slow answer.
    try {
      const live = await getOfframpStatus(orderId);
      if (live.status !== row.status) {
        await prisma.offrampOrder.update({
          where: { network_orderId: { network: net, orderId } },
          data: {
            status: live.status,
            settledStableCoin: String(live.amountStableCoin),
            settledNGN: String(live.amountNGN),
          },
        });
      }
      res.json({ ...live, depositAddress: row.depositAddress, source: "linq" });
    } catch {
      // Linq unreachable: our row is stale but true as of the last update, and
      // saying so beats failing the request outright.
      res.json({
        id: row.orderId,
        status: row.status,
        amountStableCoin: Number(row.settledStableCoin ?? row.amountStableCoin),
        amountNGN: Number(row.settledNGN ?? row.amountNGN),
        depositAddress: row.depositAddress,
        source: "cache",
      });
    }
  });

  return router;
}
