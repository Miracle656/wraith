/**
 * The operator surface: what broke, without database access.
 *
 * A failed payout used to be discoverable only by the user it happened to —
 * they saw an error, and nothing else learned about it. This router is the
 * answer to "what broke today": a token-gated list of the rows in the
 * `MoneyFailure` table, which is written by
 * {@link recordMoneyFailure} and by nothing else.
 *
 * What it deliberately is NOT:
 *
 *   - Not a log search. Ordinary request errors are not here; a 400 for a
 *     malformed bank code is not an incident and never becomes a row.
 *   - Not public. Every failure names an order, and a list of failed payouts
 *     is exactly the shape an attacker wants. `OPS_TOKEN` gates every route,
 *     and without it configured the router answers 503 — the same
 *     "this deployment has no such surface" shape the offramp router uses.
 *   - Not personal data. Rows carry the rail, the order id and what failed.
 *     Never a NIN, never bank details, never an amount: NDPA, and this
 *     surface does not need them to answer its question.
 */
import { timingSafeEqual } from "crypto";
import { Router, Request, Response, NextFunction } from "express";

import { prisma } from "../db";
import { isMoneyFailureKind, isMoneyFailureRail } from "../linq/moneyFailures";

function isConfigured(): boolean {
  return Boolean(process.env.OPS_TOKEN?.trim());
}

/**
 * Constant-time comparison of the presented token against the configured one.
 *
 * Length is compared first because `timingSafeEqual` requires equal lengths —
 * and a mismatched length is not a secret worth protecting, only the content
 * is.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The bearer token from the Authorization header, or null. */
function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** Default and cap for `GET /failures`. A page, not an export. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function createOpsRouter(): Router {
  const router = Router();

  // Every route needs the token. The failures list names orders; without the
  // gate it would be a public index of every payout that did not complete.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!isConfigured()) {
      res.status(503).json({ error: "Ops endpoints are not configured on this deployment" });
      return;
    }
    const token = bearerToken(req);
    if (!token || !tokenMatches(token, process.env.OPS_TOKEN!.trim())) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({ error: "An operator token is required" });
      return;
    }
    next();
  });

  /**
   * Recent money-affecting failures, newest first.
   *
   * Query params, all optional:
   *   rail   — one of the bounded rails (offramp, onramp, bill, unknown)
   *   kind   — one of the bounded kinds (payout_rejected, order_failed,
   *            reconcile_failed)
   *   limit  — page size, 1..200, default 50
   */
  router.get("/failures", async (req: Request, res: Response) => {
    const rail = req.query["rail"];
    if (rail !== undefined && !isMoneyFailureRail(rail)) {
      res.status(400).json({ error: "rail must be one of: offramp, onramp, bill, unknown" });
      return;
    }
    const kind = req.query["kind"];
    if (kind !== undefined && !isMoneyFailureKind(kind)) {
      res
        .status(400)
        .json({ error: "kind must be one of: payout_rejected, order_failed, reconcile_failed" });
      return;
    }
    const parsedLimit = parseInt(String(req.query["limit"] ?? ""), 10);
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

    // no-store: an operator refreshing during an incident must see the row
    // the failure just wrote, not a cached page from before it.
    res.setHeader("Cache-Control", "no-store");

    try {
      // Newest first by primary key: every insert is an autoincrement, so this
      // orders by time of recording without a clock-skew footnote, and the
      // (network, createdAt) index serves the filter.
      const rows = await prisma.moneyFailure.findMany({
        where: {
          ...(rail ? { rail } : {}),
          ...(kind ? { kind } : {}),
        },
        orderBy: { id: "desc" },
        take: limit,
      });

      res.json({
        failures: rows.map((row) => ({
          network: row.network,
          rail: row.rail,
          kind: row.kind,
          orderId: row.orderId,
          publicId: row.publicId,
          providerCode: row.providerCode,
          message: row.message,
          occurrences: row.occurrences,
          firstSeenAt: row.createdAt.toISOString(),
          lastSeenAt: row.updatedAt.toISOString(),
        })),
        limit,
      });
    } catch (err) {
      console.error(
        "[ops] could not list money failures:",
        (err as Error)?.name ?? "unknown error",
      );
      res.status(500).json({ error: "Could not list failures" });
    }
  });

  return router;
}
