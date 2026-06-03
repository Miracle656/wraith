import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../db";

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
        const { url, secret, filter, active } = req.body;

        if (!url || typeof url !== "string") {
          res.status(400).json({ error: "url is required and must be a string" });
          return;
        }
        if (!secret || typeof secret !== "string") {
          res.status(400).json({ error: "secret is required and must be a string" });
          return;
        }
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
          res.status(400).json({ error: "url must start with http:// or https://" });
          return;
        }

        // Validate optional filter shape
        if (filter !== undefined && filter !== null) {
          const allowed = new Set(["contract", "from", "to", "min_amount"]);
          const unknown = Object.keys(filter).filter((k) => !allowed.has(k));
          if (unknown.length) {
            res.status(400).json({ error: `Unknown filter keys: ${unknown.join(", ")}` });
            return;
          }
        }

        const sub = await prisma.webhookSubscription.create({
          data: {
            url,
            secret,
            filter: filter ?? null,
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
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
          res.status(400).json({ error: "id must be an integer" });
          return;
        }

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
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
          res.status(400).json({ error: "id must be an integer" });
          return;
        }

        const existing = await prisma.webhookSubscription.findUnique({ where: { id } });
        if (!existing) {
          res.status(404).json({ error: "Subscription not found" });
          return;
        }

        const { status, limit, offset } = req.query;
        const lim = Math.min(parseInt(String(limit  ?? "50"),  10) || 50, 200);
        const off =           parseInt(String(offset ?? "0"),  10) || 0;

        const VALID_STATUSES = new Set(["pending", "success", "failed"]);
        const statusFilter =
          status && VALID_STATUSES.has(String(status))
            ? { status: String(status) }
            : {};

        const where = { subscriptionId: id, ...statusFilter };

        const [total, deliveries] = await prisma.$transaction([
          prisma.webhookDelivery.count({ where }),
          prisma.webhookDelivery.findMany({
            where,
            orderBy: { id: "desc" },
            take: lim,
            skip: off,
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

        res.json({ total, limit: lim, offset: off, deliveries });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
