import {
  enrichNftMetadata,
  resolveNftMetadataOptions,
  type NftMetadataDeps,
  type NftMetadataItem,
} from "../indexer/nft-metadata";

import { StrKey } from "@stellar/stellar-sdk";

// Built from raw bytes, so it is a valid strkey by construction rather than a
// hand-typed string with a checksum nobody verified.
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 11));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function items(n: number): NftMetadataItem<string>[] {
  return Array.from({ length: n }, (_, i) => ({
    contractId: CONTRACT,
    tokenId: String(i),
    key: `key-${i}`,
  }));
}

function makeDeps(over: Partial<NftMetadataDeps<string>> = {}) {
  const upserts: string[] = [];
  const deps: NftMetadataDeps<string> = {
    getCached: async () => null,
    fetch: async (_c, key) => ({ name: key }),
    upsert: async (_c, tokenId) => { upserts.push(tokenId); },
    ...over,
  };
  return { deps, upserts };
}

describe("enrichNftMetadata", () => {
  it("does not cost N serial round trips: 20 tokens x 50ms finish in far less than 1000ms", async () => {
    let inFlight = 0;
    let peak = 0;
    const { deps, upserts } = makeDeps({
      fetch: async (_c, key) => {
        inFlight++; peak = Math.max(peak, inFlight);
        await sleep(50);
        inFlight--;
        return { name: key };
      },
    });
    const start = Date.now();
    const res = await enrichNftMetadata(items(20), deps, { concurrency: 5, budgetMs: 5000 });
    const elapsed = Date.now() - start;

    expect(res).toMatchObject({ unique: 20, stored: 20, failed: 0, deferred: 0 });
    expect(upserts).toHaveLength(20);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
    expect(elapsed).toBeLessThan(700); // serial would be >= 1000ms
  });

  it("de-duplicates repeated (contract, token) pairs and skips cached ones", async () => {
    const fetchSpy = jest.fn(async () => ({}));
    const { deps } = makeDeps({
      getCached: async (_c, t) => (t === "1" ? { name: "x" } : null),
      fetch: fetchSpy,
    });
    const res = await enrichNftMetadata([...items(3), ...items(3)], deps, { concurrency: 2 });
    expect(res).toMatchObject({ unique: 3, cached: 1, stored: 2 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("a slow source cannot stall past the budget, and unfinished tokens are not stored", async () => {
    const { deps, upserts } = makeDeps({
      fetch: () => new Promise(() => {}), // never settles
    });
    const start = Date.now();
    const res = await enrichNftMetadata(items(10), deps, { concurrency: 3, budgetMs: 100 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(600);
    expect(res.stored).toBe(0);
    expect(res.deferred).toBe(10);
    expect(upserts).toHaveLength(0); // stays uncached, retried next cycle
  });

  it("stops starting new lookups once the budget is spent", async () => {
    const fetchSpy = jest.fn(async () => { await sleep(40); return {}; });
    const { deps } = makeDeps({ fetch: fetchSpy });
    const res = await enrichNftMetadata(items(30), deps, { concurrency: 1, budgetMs: 100 });
    expect(fetchSpy.mock.calls.length).toBeLessThan(30);
    expect(res.stored + res.deferred + res.failed).toBe(30);
    expect(res.deferred).toBeGreaterThan(0);
  });

  it("a failing source is per-token: it does not throw and other tokens still store", async () => {
    const errors: string[] = [];
    const { deps, upserts } = makeDeps({
      fetch: async (_c, key) => {
        if (key === "key-2") throw new Error("https://secret.provider/url unreachable");
        return { name: key };
      },
    });
    const res = await enrichNftMetadata(items(5), deps, {
      concurrency: 2,
      onError: (m) => errors.push(m),
    });
    expect(res).toMatchObject({ stored: 4, failed: 1, deferred: 0 });
    expect(upserts.sort()).toEqual(["0", "1", "3", "4"]);
    expect(errors).toEqual(["NFT metadata lookup failed"]);
  });

  it("mixed batch: cached, ok, failing and hung tokens are handled independently", async () => {
    const { deps, upserts } = makeDeps({
      getCached: async (_c, t) => (t === "0" ? { name: "cached" } : null),
      fetch: async (_c, key) => {
        if (key === "key-1") throw new Error("boom");
        if (key === "key-2") return new Promise(() => {});
        return { name: key };
      },
    });
    const res = await enrichNftMetadata(items(5), deps, { concurrency: 5, budgetMs: 100 });
    expect(res).toMatchObject({ unique: 5, cached: 1, failed: 1, deferred: 1, stored: 2 });
    expect(upserts.sort()).toEqual(["3", "4"]);
  });

  it("a throwing upsert or cache read only costs that token", async () => {
    const { deps } = makeDeps({
      getCached: async (_c, t) => { if (t === "0") throw new Error("db"); return null; },
      upsert: async (_c, t) => { if (t === "1") throw new Error("db"); },
    });
    const res = await enrichNftMetadata(items(3), deps, { concurrency: 3 });
    expect(res).toMatchObject({ failed: 2, stored: 1 });
  });

  it("handles an empty batch", async () => {
    const { deps } = makeDeps();
    expect(await enrichNftMetadata([], deps)).toMatchObject({ unique: 0, stored: 0 });
  });
});

describe("resolveNftMetadataOptions", () => {
  afterEach(() => {
    delete process.env.NFT_METADATA_CONCURRENCY;
    delete process.env.NFT_METADATA_BUDGET_MS;
  });

  it("uses safe defaults and ignores junk values", () => {
    expect(resolveNftMetadataOptions()).toEqual({ concurrency: 8, budgetMs: 10000 });
    process.env.NFT_METADATA_CONCURRENCY = "0";
    process.env.NFT_METADATA_BUDGET_MS = "abc";
    expect(resolveNftMetadataOptions()).toEqual({ concurrency: 8, budgetMs: 10000 });
  });

  it("honours valid overrides", () => {
    process.env.NFT_METADATA_CONCURRENCY = "3";
    process.env.NFT_METADATA_BUDGET_MS = "2500";
    expect(resolveNftMetadataOptions()).toEqual({ concurrency: 3, budgetMs: 2500 });
  });
});
