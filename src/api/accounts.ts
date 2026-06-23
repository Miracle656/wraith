import { Router, Request, Response, NextFunction } from "express";
import { getAccountSummary } from "../db";
import { toDisplayAmount } from "../api";
import { createAccountsTransfersRouter } from "../routes/accounts/transfers";

/**
 * Accounts router — mounts at /accounts
 *
 * Endpoints:
 *   GET /accounts/:address/summary
 *     Returns one row per asset the address has ever sent or received.
 *     Reads from the materialized AccountSummary table — O(1) per query.
 *
 *   GET /accounts/:address/transfers
 *     Returns token transfers sent or received by the address.
 *     Supports token-scoped filtering with ?token=C...
 *
 *   Query params:
 *     contractId  — filter to a single token contract
 */
export function createAccountsRouter(): Router {
  const router = Router({ mergeParams: true });

  router.use("/:address/transfers", createAccountsTransfersRouter());

  // ── GET /accounts/:address/summary ─────────────────────────────────────────
  router.get(
    "/:address/summary",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { address } = req.params;
        const { contractId } = req.query;

        const rows = await getAccountSummary(
          address,
          contractId as string | undefined
        );

        const assets = rows.map((row) => {
          const net = BigInt(row.net);
          return {
            contractId:          row.contractId,
            totalSent:           row.totalSent,
            totalReceived:       row.totalReceived,
            net:                 row.net,
            displayTotalSent:    toDisplayAmount(row.totalSent),
            displayTotalReceived:toDisplayAmount(row.totalReceived),
            displayNet:          toDisplayAmount(net < 0n ? (-net).toString() : row.net) + (net < 0n ? " (negative)" : ""),
            txCount:             row.txCount,
            lastActivityAt:      row.lastActivityAt,
          };
        });

        res.json({ address, assets });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
