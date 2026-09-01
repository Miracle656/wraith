import { Router, Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { parseOr400 } from "../openapi/validation";
import {
  webhookCreateBodySchema,
  webhookDeliveriesParamsSchema,
  webhookDeliveriesQuerySchema,
  webhookDeleteParamsSchema,
} from "../openapi/schemas";

/**
 * Webhooks router — mounts at /webhooks
 *
 * Endpoints:
 *   POST   /webhooks                        — create a subscription
 *   GET    /webhooks                        — list all subscriptions (secret redacted)
 *   DELETE /webhooks/:id                    — delete a subscription
 *   GET    /webhooks/:id/deliveries         — query the delivery log
 *
 * The `secret` field is never returned by GET endpoints.
 */
export function createWebhooksRouter(): Router {
  const router = Router();

  // ── POST /webhooks ──────────────────────────────────────────────────────────
  /**
   * Create a new webhook subscription.
   *
   * Body (JSON):
   *   url        {string}  — HTTPS endpoint to receive POSTs
   *   secret     {string}  — shared secret for HMAC-SHA256 signing
   *   filter     {object}  — optional: { contract?, from?, to?, min_amount? }
   *   active     {boolean} — optional, default true
   *
   * Response: 201 { id, url, filter, active, createdAt }
   */
  router.post(
    "/",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(webhookCreateBodySchema, req.body, res);
        if (!parsed) return;
        const { url, secret, filter, active } = parsed;

        const sub = await prisma.webhookSubscription.create({
          data: {
            url,
            secret,
            filter: filter === undefined || filter === null ? Prisma.JsonNull : filter,
            active: active !== false,
          },
        });

        res.status(201).json({
          id:        sub.id,
          url:       sub.url,
          filter:    sub.filter,
          active:    sub.active,
          createdAt: sub.createdAt,
          // How to verify the X-Wraith-Signature header on your receiver:
          //
          //   const expected = 'sha256=' +
          //     crypto.createHmac('sha256', secret)
          //           .update(rawRequestBody)   // raw bytes BEFORE JSON.parse
          //           .digest('hex');
          //   const ok = crypto.timingSafeEqual(
          //     Buffer.from(expected),
          //     Buffer.from(req.headers['x-wraith-signature'])
          //   );
          //
          // Always use the raw request body, never a re-stringified object
          // (JSON key order is not guaranteed). Use timingSafeEqual to prevent
          // timing-based attacks.
          signatureVerification: {
            header:    "X-Wraith-Signature",
            algorithm: "sha256",
            format:    "sha256=<hex-digest>",
            body:      "raw request body bytes (before JSON.parse)",
            example:   "crypto.createHmac('sha256', secret).update(rawBody).digest('hex')",
            safeCompare: "use crypto.timingSafeEqual — never ===",
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ── GET /webhooks ───────────────────────────────────────────────────────────
  /**
   * List all webhook subscriptions. The `secret` field is omitted.
   *
   * Response: 200 { subscriptions: [...] }
   */
  router.get(
    "/",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const subs = await prisma.webhookSubscription.findMany({
          orderBy: { id: "asc" },
          select: {
            id:        true,
            url:       true,
            filter:    true,
            active:    true,
            createdAt: true,
            updatedAt: true,
          },
        });

        res.json({ subscriptions: subs });
      } catch (err) {
        next(err);
      }
    }
  );

  // ── DELETE /webhooks/:id ────────────────────────────────────────────────────
  /**
   * Delete a subscription and cascade-delete its delivery history.
   *
   * Response: 200 { ok: true }
   */
  router.delete(
    "/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(webhookDeleteParamsSchema, req.params, res);
        if (!parsed) return;
        const { id } = parsed;

        const existing = await prisma.webhookSubscription.findUnique({ where: { id } });
        if (!existing) {
          res.status(404).json({ error: "Subscription not found" });
          return;
        }

        await prisma.webhookSubscription.delete({ where: { id } });
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    }
  );

  // ── GET /webhooks/:id/deliveries ────────────────────────────────────────────
  /**
   * Query the delivery log for a subscription.
   *
   * Query params:
   *   status  — filter by status: "pending" | "success" | "failed"
   *   limit   — page size (max 200, default 50)
   *   offset  — pagination offset (default 0)
   *
   * Response: 200 { total, limit, offset, deliveries: [...] }
   */
  router.get(
    "/:id/deliveries",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const params = parseOr400(webhookDeliveriesParamsSchema, req.params, res);
        if (!params) return;
        const { id } = params;

        const existing = await prisma.webhookSubscription.findUnique({ where: { id } });
        if (!existing) {
          res.status(404).json({ error: "Subscription not found" });
          return;
        }

        const query = parseOr400(webhookDeliveriesQuerySchema, req.query, res);
        if (!query) return;
        const { status, limit, offset } = query;

        const where = { subscriptionId: id, ...(status ? { status } : {}) };

        const [total, deliveries] = await prisma.$transaction([
          prisma.webhookDelivery.count({ where }),
          prisma.webhookDelivery.findMany({
            where,
            orderBy: { id: "desc" },
            take: limit,
            skip: offset,
            select: {
              id:             true,
              eventId:        true,
              status:         true,
              attempts:       true,
              lastStatusCode: true,
              lastError:      true,
              nextRetryAt:    true,
              deliveredAt:    true,
              createdAt:      true,
            },
          }),
        ]);

        res.json({ total, limit, offset, deliveries });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
