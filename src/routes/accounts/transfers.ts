import { Router, Request, Response, NextFunction } from "express";
import { queryAllTransfers } from "../../db";

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
        const { address } = req.params;
        const {
          contractId,
          fromLedger,
          toLedger,
          fromDate,
          toDate,
          eventType,
          limit,
          offset,
          token,
          cursor,
          $filter,
          $select,
        } = req.query;

        const fromDateVal = parseDateParam(fromDate, res);
        if (fromDateVal === null) return;
        const toDateVal = parseDateParam(toDate, res);
        if (toDateVal === null) return;
        const eventTypes = parseEventTypes(eventType, res);
        if (eventTypes === null) return;

        if (token !== undefined) {
          const tokenStr = String(token).trim();
          if (!tokenStr.startsWith("C") || tokenStr.length !== 56) {
            res.status(400).json({
              error: `Invalid token address: "${tokenStr}". Must be a 56-character Stellar contract address starting with "C".`,
            });
            return;
          }
        }

        const lim = parseIntParam(limit, 50);
        const off = parseIntParam(offset, 0);

        const result = await queryAllTransfers({
          address,
          contractId: contractId as string | undefined,
          token: token !== undefined ? String(token).trim() : undefined,
          filter: $filter as string | undefined,
          select: typeof $select === "string" ? String($select).split(",").map((item) => item.trim()).filter(Boolean) : undefined,
          cursor: cursor as string | undefined,
          fromLedger: fromLedger ? parseIntParam(fromLedger, 0) : undefined,
          toLedger: toLedger ? parseIntParam(toLedger, 0) : undefined,
          fromDate: fromDateVal,
          toDate: toDateVal,
          eventTypes,
          limit: lim,
          offset: off,
        });

        res.json({
          ...result,
          transfers: result.transfers.map((transfer) => {
            if (transfer && typeof (transfer as { amount?: unknown }).amount === "string") {
              return withDisplay(transfer as { amount: string });
            }
            return transfer;
          }),
          limit: lim,
          offset: off,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
