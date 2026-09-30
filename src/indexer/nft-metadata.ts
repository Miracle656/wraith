/**
 * Bounded NFT metadata enrichment (#205).
 *
 * Metadata is enrichment; transfers are the product. Looking metadata up one
 * token at a time meant a batch of N new tokens cost N serial round trips
 * before the poll cycle could advance. This runs the lookups through a small
 * worker pool and caps the total time a cycle may spend on them.
 *
 * Guarantees:
 *  - at most `concurrency` lookups are in flight at once;
 *  - no lookup starts after the budget is spent, and an in-flight lookup that
 *    outlives the budget is abandoned, so the caller returns within roughly
 *    `budgetMs` no matter how slow the source is;
 *  - a token's failure (cache read, fetch or upsert) never affects another;
 *  - tokens that were skipped or timed out are NOT written, so they stay
 *    uncached and are retried on a later cycle.
 */

export interface NftMetadataPayload {
  name?: string;
  tokenUri?: string;
}

export interface NftMetadataItem<K = unknown> {
  contractId: string;
  tokenId: string;
  /** Opaque handle passed back to `fetch` (the token id ScVal in production). */
  key: K;
}

export interface NftMetadataDeps<K = unknown> {
  /** Resolves truthy when metadata is already stored for the token. */
  getCached: (contractId: string, tokenId: string) => Promise<unknown>;
  fetch: (contractId: string, key: K) => Promise<NftMetadataPayload>;
  upsert: (contractId: string, tokenId: string, meta: NftMetadataPayload) => Promise<unknown>;
}

export interface NftMetadataOptions {
  concurrency?: number;
  budgetMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  onError?: (message: string, err: unknown) => void;
}

export interface NftMetadataResult {
  /** Unique tokens considered. */
  unique: number;
  /** Already cached, nothing to do. */
  cached: number;
  /** Fetched and stored. */
  stored: number;
  /** Failed individually (cache read, fetch or upsert threw). */
  failed: number;
  /** Not stored because the cycle budget ran out; retried next cycle. */
  deferred: number;
}

export const DEFAULT_NFT_METADATA_CONCURRENCY = 8;
export const DEFAULT_NFT_METADATA_BUDGET_MS = 10_000;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Read NFT_METADATA_CONCURRENCY / NFT_METADATA_BUDGET_MS, ignoring junk. */
export function resolveNftMetadataOptions(): Required<Pick<NftMetadataOptions, "concurrency" | "budgetMs">> {
  return {
    concurrency: positiveInt(process.env.NFT_METADATA_CONCURRENCY, DEFAULT_NFT_METADATA_CONCURRENCY),
    budgetMs: positiveInt(process.env.NFT_METADATA_BUDGET_MS, DEFAULT_NFT_METADATA_BUDGET_MS),
  };
}

const TIMED_OUT = Symbol("timed-out");

/** Race `p` against `ms`, clearing the timer either way. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(ms, 0));
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function enrichNftMetadata<K>(
  items: ReadonlyArray<NftMetadataItem<K>>,
  deps: NftMetadataDeps<K>,
  opts: NftMetadataOptions = {},
): Promise<NftMetadataResult> {
  const defaults = resolveNftMetadataOptions();
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? defaults.concurrency));
  const budgetMs = opts.budgetMs ?? defaults.budgetMs;
  const now = opts.now ?? Date.now;
  const onError = opts.onError ?? (() => {});

  // One lookup per unique (contract, token) pair.
  const seen = new Set<string>();
  const unique: Array<NftMetadataItem<K>> = [];
  for (const item of items) {
    const id = `${item.contractId}:${item.tokenId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(item);
  }

  const result: NftMetadataResult = { unique: unique.length, cached: 0, stored: 0, failed: 0, deferred: 0 };
  const deadline = now() + budgetMs;
  let next = 0;

  async function processOne(item: NftMetadataItem<K>): Promise<void> {
    const remaining = () => deadline - now();
    try {
      const cached = await withTimeout(deps.getCached(item.contractId, item.tokenId), remaining());
      if (cached === TIMED_OUT) { result.deferred++; return; }
      if (cached) { result.cached++; return; }

      const meta = await withTimeout(deps.fetch(item.contractId, item.key), remaining());
      if (meta === TIMED_OUT) { result.deferred++; return; }

      const stored = await withTimeout(deps.upsert(item.contractId, item.tokenId, meta), remaining());
      if (stored === TIMED_OUT) { result.deferred++; return; }
      result.stored++;
    } catch (err) {
      result.failed++;
      onError("NFT metadata lookup failed", err);
    }
  }

  async function worker(): Promise<void> {
    while (next < unique.length) {
      const item = unique[next++];
      if (now() >= deadline) { result.deferred++; continue; }
      await processOne(item);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return result;
}
