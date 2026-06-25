import { Router, Request, Response, NextFunction } from "express";
import { queryPopularAssets, toDisplayAmount } from "../../db";

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
        const window = (req.query.window as string) || "24h";
        const by = (req.query.by as string) || "transfers";
        const limit = parseInt(String(req.query.limit ?? "20"), 10);
        const offset = parseInt(String(req.query.offset ?? "0"), 10);

        if (!VALID_WINDOWS.has(window)) {
          res.status(400).json({
            error: `Invalid window: "${window}". Valid values: 1h, 24h, 7d.`,
          });
          return;
        }

        if (!VALID_SORT_BY.has(by)) {
          res.status(400).json({
            error: `Invalid by: "${by}". Valid values: transfers, volume.`,
          });
          return;
        }

        const fromDate = windowToDate(window);
        const { total, assets } = await queryPopularAssets({ fromDate, by, limit, offset });

        res.json({
          window,
          by,
          limit: Math.min(limit, 100),
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
