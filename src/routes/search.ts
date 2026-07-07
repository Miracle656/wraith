import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../db";
import { parseOr400 } from "../openapi/validation";
import { searchQuerySchema } from "../openapi/schemas";

// Top-10 hits across all types; fetch up to this many per type before merging.
const MAX_RESULTS = 10;
const PER_TYPE = 10;

export type SearchType = "account" | "asset" | "contract";

export interface SearchHit {
  type: SearchType;
  value: string;
  isSac?: boolean;
  lastActivityAt?: string;
}

export interface RawAccountHit {
  address: string;
  lastActivityAt: Date;
}
export interface RawAssetHit {
  contractId: string;
  isSac: boolean;
}
export interface RawContractHit {
  contractId: string;
}

/**
 * Stellar strkeys (G… accounts, C… contracts) are uppercase base32, so we
 * upper-case the query and match by prefix. A leading-anchored prefix match
 * uses the existing btree indexes, keeping lookups sub-100ms.
 */
export function normalizeQuery(q: string): string {
  return q.trim().toUpperCase();
}

/**
 * Merges typed hits into a single list, de-duplicated by value and capped at
 * `limit`. Accounts come first, then assets; a token contract surfaces as an
 * "asset" rather than a generic "contract" when it appears in both.
 */
export function mergeSearchHits(
  accounts: RawAccountHit[],
  assets: RawAssetHit[],
  contracts: RawContractHit[],
  limit: number,
): SearchHit[] {
  const seen = new Set<string>();
  const hits: SearchHit[] = [];

  const push = (hit: SearchHit): void => {
    if (seen.has(hit.value)) return;
    seen.add(hit.value);
    hits.push(hit);
  };

  for (const a of accounts) {
    push({ type: "account", value: a.address, lastActivityAt: a.lastActivityAt.toISOString() });
  }
  for (const a of assets) {
    push({ type: "asset", value: a.contractId, isSac: a.isSac });
  }
  for (const c of contracts) {
    push({ type: "contract", value: c.contractId });
  }

  return hits.slice(0, limit);
}

export function createSearchRouter(): Router {
  const router = Router();

  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = parseOr400(searchQuerySchema, req.query, res);
      if (!parsed) return;

      const q = normalizeQuery(parsed.q);

      const [accounts, assets, contracts] = await Promise.all([
        prisma.accountSummary.findMany({
          where: { address: { startsWith: q } },
          distinct: ["address"],
          orderBy: [{ address: "asc" }],
          take: PER_TYPE,
          select: { address: true, lastActivityAt: true },
        }),
        prisma.tokenTransfer.findMany({
          where: { contractId: { startsWith: q } },
          distinct: ["contractId"],
          orderBy: [{ contractId: "asc" }],
          take: PER_TYPE,
          select: { contractId: true, isSac: true },
        }),
        prisma.hostFnLog.findMany({
          where: { contractId: { startsWith: q } },
          distinct: ["contractId"],
          orderBy: [{ contractId: "asc" }],
          take: PER_TYPE,
          select: { contractId: true },
        }),
      ]);

      const results = mergeSearchHits(accounts, assets, contracts, MAX_RESULTS);
      res.json({ query: parsed.q, count: results.length, results });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
