import { Router, Request, Response, NextFunction } from "express";
import { getAccountSummary, queryBalances } from "../db";
import { toDisplayAmount } from "../amount";
import { createAccountsTransfersRouter } from "../routes/accounts/transfers";
import { parseOr400 } from "../openapi/validation";
import { summaryQuerySchema } from "../openapi/schemas";
import { requestNetwork } from "../middleware/network";
import { getCachedTokenDecimals } from "../tokenCache";

type AccountSummaryRow = Awaited<ReturnType<typeof getAccountSummary>>[number];

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

  // ── GET /accounts/:address/balance ─────────────────────────────────────────
  /**
   * Per-token balance for an address, derived from indexed transfers.
   *
   * `derivedFromLedger` and the note are part of the contract, not decoration:
   * this is a sum over the indexed window, so an address that held a token
   * before the indexer's start ledger reads low, and one that was net-negative
   * over that window reads negative. A caller that mistakes this for an
   * on-chain balance read will be wrong in a way the numbers do not reveal.
   */
  router.get(
    "/:address/balance",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { address } = req.params;
        const network = requestNetwork(req);
        const rows = await queryBalances(address, network);

        res.json({
          address,
          network,
          balances: rows.map((row) => ({
            contractId: row.contractId,
            balance: row.balance,
            displayBalance: toDisplayAmount(row.balance, getCachedTokenDecimals(row.contractId, network)),
          })),
          derivedFromLedger: true,
          note:
            "Derived by summing indexed transfers, not read from chain. Excludes " +
            "any history before the indexer's start ledger.",
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ── GET /accounts/:address/summary ─────────────────────────────────────────
  router.get(
    "/:address/summary",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(summaryQuerySchema, { ...req.params, ...req.query }, res);
        if (!parsed) return;
        const { address, contractId } = parsed;

        const network = requestNetwork(req);
        const rows = await getAccountSummary(address, contractId, network);

        const assets = rows.map((row: AccountSummaryRow) => {
          const net = BigInt(row.net);
          return {
            contractId:          row.contractId,
            totalSent:           row.totalSent,
            totalReceived:       row.totalReceived,
            net:                 row.net,
            displayTotalSent:    toDisplayAmount(row.totalSent, getCachedTokenDecimals(row.contractId, network)),
            displayTotalReceived:toDisplayAmount(row.totalReceived, getCachedTokenDecimals(row.contractId, network)),
            displayNet:          toDisplayAmount(net < 0n ? (-net).toString() : row.net, getCachedTokenDecimals(row.contractId, network)) + (net < 0n ? " (negative)" : ""),
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
