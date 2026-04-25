import { Router, Request, Response, NextFunction } from "express";
import { queryBalances } from "../db";
import { toDisplayAmount } from "../api";

const router = Router();

/**
 * GET /accounts/:address/balance
 * Returns per-token derived balances for an address by summing incoming
 * transfers and subtracting outgoing ones from the indexed history.
 */
router.get("/:address/balance", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { address } = req.params;
    const rows = await queryBalances(address);

    const balances = rows.map((row) => ({
      token: row.contractId,
      balance: toDisplayAmount(row.balance),
    }));

    res.json({
      balances,
      derived_from_ledger: true,
      note: "This balance is derived from indexed token transfers and may not include pre-indexer history.",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
