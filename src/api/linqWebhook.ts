import express, { Request, Response, Router } from "express";

import {
  SIGNATURE_HEADER,
  parseEvent,
  resolveEventNetwork,
  verifySignature,
} from "../linq/webhook";
import { recordMoneyFailure } from "../linq/moneyFailures";
import { reconcileNgnOrder } from "../linq/ngnOrders";
import { reconcileOfframpOrder } from "../linq/offrampOrders";
import { DEFAULT_NETWORK } from "../network";

/**
 * Linq's webhook, for every rail.
 *
 * One endpoint carries offramp, onramp and bill events, and the body does not
 * say which rail an event belongs to — only an `orderId` (and, optionally, a
 * `network`). So reconciliation is "find the order that id belongs to" using
 * the compound `(network, orderId)` key: the offramp table first, then the NGN
 * one. An id in neither is not ours. A missing network resolves to the
 * deployment's configured network; an invalid one is ignored.
 *
 * The bill case is what made this necessary. An onramp delivering XLM shows up
 * on-chain, where the indexer already sees it and the address subscription
 * pushes it; a biller refusing to vend after the user has paid shows up
 * nowhere unless this runs.
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
        // Idempotent per event: the update targets a row keyed on
        // (network, orderId) and writes the settled figures. A redelivery of
        // the SAME event writes the same values a second time, which is a
        // no-op rather than a double-count (pinned in
        // __tests__/routes/idempotency.test.ts).
        // Nothing here creates a row - an event for an order we never placed
        // is not ours to act on.
        //
        // Not order-safe, though: the last delivery wins. A late redelivery
        // of `order.processing` arriving after `order.completed` sets the
        // status back to processing. Nothing is counted twice, but the row
        // reads wrong until the next status poll corrects it.
        const network = resolveEventNetwork(event);
        if (!network) {
          console.warn(`[linq] webhook for order ${event.orderId} names an invalid network`);
          return;
        }

        // Same reconciliation the periodic sweep uses, so a webhook that
        // arrives late and a poll that arrives first cannot disagree.
        if (await reconcileOfframpOrder(event)) return;

        // Not an offramp order — try the onramp/bill table before giving up.
        if (await reconcileNgnOrder(event)) return;
        console.warn(`[linq] webhook for unknown order ${event.orderId}`);
      } catch (err) {
        // The response has already gone, so this cannot fail the delivery.
        // Logged loudly because the reconciliation is now missing and only the
        // status poll will catch it up.
        console.error("[linq] failed to reconcile webhook:", err);

        // "Reconciliation gave up" is its own money-affecting failure: the
        // event asserts money moved, and our rows no longer describe it. The
        // rail is unknown here — the event may name an order in either table
        // and the lookup itself is what failed. The error's name only: a
        // database error's message is not operator-facing prose.
        await recordMoneyFailure({
          network: DEFAULT_NETWORK,
          rail: "unknown",
          kind: "reconcile_failed",
          orderId: event.orderId,
          providerCode: event.status ?? event.event,
          message:
            `Webhook event "${event.event}" for order ${event.orderId} could not be reconciled ` +
            `(${(err as Error)?.name ?? "unknown error"}); only a status poll can catch it up.`,
        });
      }
    },
  );

  return router;
}
