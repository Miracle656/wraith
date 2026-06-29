import { Router, Request, Response, NextFunction } from "express";
import { queryPopularAssets, toDisplayAmount } from "../../db";
import { parseOr400 } from "../../openapi/validation";
import { popularAssetsQuerySchema } from "../../openapi/schemas";

const VALID_WINDOWS = new Set(["1h", "24h", "7d"]);
const VALID_SORT_BY = new Set(["transfers", "volume"]);

function windowToDate(window: string): Date {
  const now = new Date();
  switch (window) {
    case "1h":
      return new Date(now.getTime() - 60 * 60 * 1000);
    case "24h":
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    default:
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
}

export function createPopularAssetsRouter(): Router {
  const router = Router();

  router.get(
    "/popular",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(popularAssetsQuerySchema, req.query, res);
        if (!parsed) return;
        const { window, by, limit, offset } = parsed;

        const fromDate = windowToDate(window);
        const { total, assets } = await queryPopularAssets({ fromDate, by, limit, offset });

        res.json({
          window,
          by,
          limit,
          offset,
          total,
          assets: assets.map((a) => ({
            contractId: a.contractId,
            transferCount: Number(a.transferCount),
            volume: a.volume,
            displayVolume: toDisplayAmount(a.volume),
          })),
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
