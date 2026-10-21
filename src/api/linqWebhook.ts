import express, { Request, Response, Router } from "express";
import { prisma } from "../db";
import { SIGNATURE_HEADER, parseEvent, verifySignature } from "../linq/webhook";
import { DEFAULT_NETWORK } from "../network";
import { isNairaAmountPlausible, MIN_NGN, MAX_NGN } from "../amount";

/**
 * Linq's webhook, for every rail.
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
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      const event = parseEvent(raw);
      if (!event) {
        res.status(400).json({ error: "Unrecognised event" });
        return;
      }

      // Acknowledge first, reconcile after
      res.status(200).json({ ok: true });

      try {
        const network = DEFAULT_NETWORK;

        // 1. Try finding in offrampOrder first
        const existingOfframp = await prisma.offrampOrder.findFirst({
          where: { orderId: event.orderId },
        });

        if (existingOfframp) {
          // Validate NGN bounds if present
          if (event.amountNGN != null) {
            if (!isNairaAmountPlausible(event.amountNGN)) {
              console.error(
                `[linq] rejecting webhook for order ${event.orderId}: amountNGN ${event.amountNGN} outside plausible band [${MIN_NGN}, ${MAX_NGN}]`
              );
              return;
            }
            const orderNgn =
              existingOfframp.amountNGN != null
                ? Number(existingOfframp.amountNGN)
                : null;
            if (orderNgn != null && orderNgn > 0) {
              const ratio = event.amountNGN / orderNgn;
              if (ratio > 2 || ratio < 1 / 2) {
                console.error(
                  `[linq] rejecting webhook for order ${event.orderId}: amountNGN ${event.amountNGN} disagrees with order amount ${orderNgn} (ratio ${ratio})`
                );
                return;
              }
            }
          }

          await prisma.offrampOrder.update({
            where: { id: existingOfframp.id },
            data: {
              status:
                event.status ??
                (event.event === "order.completed" ? "completed" : event.event),
              ...(event.amountStableCoin != null
                ? { settledStableCoin: String(event.amountStableCoin) }
                : {}),
              ...(event.amountNGN != null
                ? { settledNGN: String(event.amountNGN) }
                : {}),
              ...(event.txHash ? { depositTxHash: event.txHash } : {}),
            },
          });
          return;
        }

        // 2. Fallback to ngnOrder (onramp) table
        const existingNgn = await prisma.ngnOrder.findFirst({
          where: { orderId: event.orderId },
        });

        if (existingNgn) {
          // Validate NGN bounds if present
          if (event.amountNGN != null) {
            if (!isNairaAmountPlausible(event.amountNGN)) {
              console.error(
                `[linq] rejecting webhook for order ${event.orderId}: amountNGN ${event.amountNGN} outside plausible band [${MIN_NGN}, ${MAX_NGN}]`
              );
              return;
            }
            const orderNgn =
              existingNgn.amountNGN != null
                ? Number(existingNgn.amountNGN)
                : null;
            if (orderNgn != null && orderNgn > 0) {
              const ratio = event.amountNGN / orderNgn;
              if (ratio > 2 || ratio < 1 / 2) {
                console.error(
                  `[linq] rejecting webhook for order ${event.orderId}: amountNGN ${event.amountNGN} disagrees with order amount ${orderNgn} (ratio ${ratio})`
                );
                return;
              }
            }
          }

          await prisma.ngnOrder.update({
            where: { id: existingNgn.id },
            data: {
              status:
                event.status ??
                (event.event === "order.completed" ? "completed" : event.event),
              ...(event.amountStableCoin != null
                ? { settledStableCoin: String(event.amountStableCoin) }
                : {}),
              ...(event.amountNGN != null
                ? { settledNgn: Number(event.amountNGN) }
                : {}),
              ...(event.txHash ? { depositTxHash: event.txHash } : {}),
            },
          });
          return;
        }

        // 3. Not found in either table
        console.warn(`[linq] webhook for unknown order ${event.orderId}`);
      } catch (err) {
        console.error("[linq] failed to reconcile webhook:", err);
      }
    }
  );

  return router;
}