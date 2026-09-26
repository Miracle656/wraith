import express, { Request, Response, Router } from "express";

import { prisma } from "../db";
import { SIGNATURE_HEADER, parseEvent, verifySignature } from "../linq/webhook";
import { DEFAULT_NETWORK } from "../network";

/**
 * Linq's offramp webhook.
 *
 * MUST be mounted before express.json(). Linq signs the raw request body, so
 * any middleware that parses and re-serialises it first destroys the ability
 * to verify - the bytes change even when the value does not. wraith applies
 * express.json() globally in api.ts, which is exactly the trap Linq's own docs
 * warn about, so this router brings its own express.raw() and is mounted ahead
 * of it.
 *
 * The endpoint is public and its events assert that money moved, so an
 * unverified body is rejected before anything is read out of it.
 */
export function createLinqWebhookRouter(): Router {
  const router = Router();

  router.post(
    "/",
    express.raw({ type: "*/*" }),
    async (req: Request, res: Response) => {
      const secret = process.env.LINQ_WEBHOOK_SECRET?.trim() ?? "";
      const signature = req.header(SIGNATURE_HEADER) ?? undefined;
      const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

      if (!verifySignature(raw, signature, secret)) {
        // Deliberately terse. Saying which part failed tells a prober whether
        // they had the shape right.
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      const event = parseEvent(raw);
      if (!event) {
        res.status(400).json({ error: "Unrecognised event" });
        return;
      }

      // Acknowledge first, reconcile after. Linq times out at 10 seconds and
      // marks the delivery failed, and a database write on a throttled
      // instance can outlast that - at which point they retry an event we did
      // in fact process.
      res.status(200).json({ ok: true });

      try {
        // Idempotent by construction: the update targets a row keyed on the
        // order id and writes the settled figures. A redelivery writes the
        // same values a second time, which is a no-op rather than a
        // double-count. Nothing here creates a row - an event for an order we
        // never placed is not ours to act on.
        const network = DEFAULT_NETWORK;
        const existing = await prisma.offrampOrder.findFirst({
          where: { orderId: event.orderId },
        });
        if (!existing) {
          console.warn(`[linq] webhook for unknown order ${event.orderId}`);
          return;
        }

        await prisma.offrampOrder.update({
          where: {
            network_orderId: { network: existing.network ?? network, orderId: event.orderId },
          },
          data: {
            status: event.status ?? event.event,
            ...(event.amountStableCoin != null
              ? { settledStableCoin: String(event.amountStableCoin) }
              : {}),
            ...(event.amountNGN != null ? { settledNGN: String(event.amountNGN) } : {}),
            ...(event.txHash ? { depositTxHash: event.txHash } : {}),
          },
        });
      } catch (err) {
        // The response has already gone, so this cannot fail the delivery.
        // Logged loudly because the reconciliation is now missing and only the
        // status poll will catch it up.
        console.error("[linq] failed to reconcile webhook:", err);
      }
    },
  );

  return router;
}
