import { Router, Request, Response, NextFunction } from "express";
import { queryAllTransfers } from "../../db";
import { parseOr400 } from "../../openapi/validation";
import { transferQuerySchema } from "../../openapi/schemas";

const VALID_EVENT_TYPES = new Set(["transfer", "mint", "burn", "clawback"]);
const STROOPS = 10_000_000n;

function toDisplayAmount(amount: string): string {
  const raw = BigInt(amount);
  const abs = raw < 0n ? -raw : raw;
  const integer = abs / STROOPS;
  const remainder = abs % STROOPS;
  const sign = raw < 0n ? "-" : "";
  return `${sign}${integer}.${String(remainder).padStart(7, "0")}`;
}

const withDisplay = <T extends { amount: string }>(t: T) => ({
  ...t,
  displayAmount: toDisplayAmount(t.amount),
});

const parseIntParam = (val: unknown, fallback: number): number => {
  const n = parseInt(String(val), 10);
  return isNaN(n) ? fallback : n;
};

const parseEventTypes = (val: unknown, res: Response): string[] | null | undefined => {
  if (val === undefined || val === "") return undefined;
  const types = String(val).split(",").map((s) => s.trim()).filter(Boolean);
  const invalid = types.filter((t) => !VALID_EVENT_TYPES.has(t));
  if (invalid.length) {
    res.status(400).json({
      error: `Invalid eventType: "${invalid.join('", "')}". Valid values: transfer, mint, burn, clawback.`,
    });
    return null;
  }
  return types;
};

const parseDateParam = (val: unknown, res: Response): Date | null | undefined => {
  if (val === undefined || val === "") return undefined;
  const d = new Date(String(val));
  if (isNaN(d.getTime())) {
    res.status(400).json({ error: `Invalid date: "${val}". Expected ISO 8601 (e.g. 2025-01-01T00:00:00Z).` });
    return null;
  }
  return d;
};

export function createAccountsTransfersRouter(): Router {
  const router = Router({ mergeParams: true });

  router.get(
    "/",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(transferQuerySchema, { ...req.params, ...req.query }, res);
        if (!parsed) return;
        const { address, contractId, fromLedger, toLedger, fromDate, toDate, eventType, limit, offset, token, cursor, $filter, $select } = parsed as {
          address: string;
          contractId?: string;
          fromLedger?: number;
          toLedger?: number;
          fromDate?: Date;
          toDate?: Date;
          eventType?: string[];
          limit: number;
          offset: number;
          token?: string;
          cursor?: string;
          $filter?: string;
          $select?: string[];
        };

        const result = await queryAllTransfers({
          address,
          contractId,
          token,
          filter: $filter,
          select: $select as string[] | undefined,
          cursor,
          fromLedger,
          toLedger,
          fromDate,
          toDate,
          eventTypes: eventType as string[] | undefined,
          limit,
          offset,
        });

        res.json({
          ...result,
          transfers: result.transfers.map((transfer) => {
            if (transfer && typeof (transfer as { amount?: unknown }).amount === "string") {
              return withDisplay(transfer as { amount: string });
            }
            return transfer;
          }),
          limit,
          offset,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
