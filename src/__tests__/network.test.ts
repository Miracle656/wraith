/**
 * Network-scoping tests for #159.
 *
 * The failure this guards against is quiet: `network` carries a DEFAULT of
 * 'testnet', so a query that forgets to filter on it — or a write that forgets
 * to set it — still compiles, still passes a type check, and still returns
 * rows. It just returns (or writes) the wrong chain's rows. Nothing surfaces
 * until mainnet and testnet share a database, at which point balances are
 * wrong rather than missing.
 *
 * So these assert the predicate is actually present in each where clause,
 * rather than asserting that the queries merely succeed.
 *
 * db.ts resolves its client from `globalThis.prisma` before constructing one,
 * which lets us inject a recording stub and keep this a unit test with no
 * database.
 */

type AnyRecord = Record<string, any>;

/** Records every call so a test can inspect the `where` that was built. */
function recorder() {
  const calls: Array<{ model: string; op: string; args: AnyRecord }> = [];

  const model = (name: string, results: AnyRecord = {}) =>
    new Proxy(
      {},
      {
        get: (_t, op: string) => (args: AnyRecord) => {
          calls.push({ model: name, op, args: args ?? {} });
          if (op === "count") return Promise.resolve(0);
          if (op === "findMany") return Promise.resolve([]);
          if (op === "deleteMany") return Promise.resolve({ count: 0 });
          if (op === "createMany") return Promise.resolve({ count: 0 });
          if (op === "findUnique" || op === "findFirst") {
            return Promise.resolve(results[op] ?? null);
          }
          return Promise.resolve(results[op] ?? null);
        },
      }
    ) as AnyRecord;

  const raw: Array<{ strings: string[]; values: unknown[] }> = [];
  const rawFn = (strings: TemplateStringsArray | string[], ...values: unknown[]) => {
    raw.push({ strings: Array.from(strings as string[]), values });
    return Promise.resolve([]);
  };

  const stub: AnyRecord = {
    tokenTransfer: model("tokenTransfer"),
    nftTransfer: model("nftTransfer"),
    nftMetadata: model("nftMetadata"),
    hostFnLog: model("hostFnLog"),
    lpShareTransfer: model("lpShareTransfer"),
    accountSummary: model("accountSummary"),
    indexerState: model("indexerState", { findUnique: { lastIndexedLedger: 42 } }),
    backfillCursor: model("backfillCursor"),
    indexerCheckpoint: model("indexerCheckpoint"),
    $transaction: (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: AnyRecord) => unknown)(stub),
    $queryRaw: rawFn,
    $executeRaw: rawFn,
  };

  return { stub, calls, raw };
}

const { stub, calls, raw } = recorder();
(globalThis as AnyRecord).prisma = stub;

// Imported after the stub is installed — db.ts binds its client at module load.
import * as db from "../db";
import { currentNetwork, isNetwork, parseNetwork, resolveNetwork } from "../network";

/** The `where` of the last recorded call against `model`. */
function lastWhere(model: string, op?: string): AnyRecord {
  const match = [...calls].reverse().find((c) => c.model === model && (!op || c.op === op));
  if (!match) throw new Error(`no recorded ${op ?? "any"} call on ${model}`);
  return match.args.where ?? {};
}

/** Every value passed into a raw SQL template, flattened across Prisma.Sql. */
function rawValues(): unknown[] {
  return raw.flatMap((r) =>
    r.values.flatMap((v) =>
      v && typeof v === "object" && Array.isArray((v as AnyRecord).values)
        ? (v as AnyRecord).values
        : [v]
    )
  );
}

const ADDR = "GDWCO35QUYQLGO6P7OLW4BZWNMMGGUWNPLRVPLCBVG7YNVDZKUDIW4KN";
const CONTRACT = "CBC42KFZO33TYVFDOUXFRWXYYXHFGH7W5GM4IJQSXKGFINKL2XPP4XTE";

beforeEach(() => {
  calls.length = 0;
  raw.length = 0;
  delete process.env.STELLAR_NETWORK;
});

describe("network resolution", () => {
  it("defaults to testnet when STELLAR_NETWORK is unset", () => {
    expect(currentNetwork()).toBe("testnet");
  });

  it("reads STELLAR_NETWORK, case-insensitively and trimmed", () => {
    process.env.STELLAR_NETWORK = "  MAINNET ";
    expect(currentNetwork()).toBe("mainnet");
  });

  it("falls back to testnet for an unrecognised value rather than passing it through", () => {
    // A typo like STELLAR_NETWORK=main must not become a third network that
    // matches no rows and no index.
    process.env.STELLAR_NETWORK = "main";
    expect(currentNetwork()).toBe("testnet");
    expect(parseNetwork("main")).toBeNull();
  });

  it("re-reads the environment on every call", () => {
    process.env.STELLAR_NETWORK = "mainnet";
    expect(currentNetwork()).toBe("mainnet");
    process.env.STELLAR_NETWORK = "testnet";
    expect(currentNetwork()).toBe("testnet");
  });

  it("lets an explicit argument win over the environment", () => {
    process.env.STELLAR_NETWORK = "testnet";
    expect(resolveNetwork("mainnet")).toBe("mainnet");
    expect(resolveNetwork(undefined)).toBe("testnet");
  });

  it("narrows only the two real networks", () => {
    expect(isNetwork("mainnet")).toBe(true);
    expect(isNetwork("futurenet")).toBe(false);
    expect(isNetwork(undefined)).toBe(false);
  });
});

describe("reads are network-scoped", () => {
  it("queryTransfers filters on the configured network", async () => {
    process.env.STELLAR_NETWORK = "mainnet";
    await db.queryTransfers({ address: ADDR, direction: "incoming" });
    expect(lastWhere("tokenTransfer", "findMany").network).toBe("mainnet");
  });

  it("queryTransfers honours an explicit network over the environment", async () => {
    process.env.STELLAR_NETWORK = "mainnet";
    await db.queryTransfers({ address: ADDR, direction: "incoming", network: "testnet" });
    expect(lastWhere("tokenTransfer", "findMany").network).toBe("testnet");
  });

  it("counts and rows agree on the network, so total matches the page", async () => {
    process.env.STELLAR_NETWORK = "mainnet";
    await db.queryTransfers({ address: ADDR, direction: "incoming" });
    expect(lastWhere("tokenTransfer", "count").network).toBe("mainnet");
    expect(lastWhere("tokenTransfer", "findMany").network).toBe("mainnet");
  });

  it("queryAllTransfers scopes alongside its OR on address", async () => {
    await db.queryAllTransfers({ address: ADDR, network: "mainnet" });
    const where = lastWhere("tokenTransfer", "findMany");
    expect(where.network).toBe("mainnet");
    // The address OR must stay a sibling of the network filter, not replace it.
    expect(where.OR).toHaveLength(2);
  });

  it("queryNftTransfers scopes", async () => {
    await db.queryNftTransfers({ contractId: CONTRACT, network: "mainnet" });
    expect(lastWhere("nftTransfer", "findMany").network).toBe("mainnet");
  });

  it("queryAccountSummaries scopes", async () => {
    await db.queryAccountSummaries({ address: ADDR, network: "mainnet" });
    expect(lastWhere("accountSummary", "findMany").network).toBe("mainnet");
  });

  it("getAccountSummary scopes", async () => {
    await db.getAccountSummary(ADDR, undefined, "mainnet");
    expect(lastWhere("accountSummary", "findMany").network).toBe("mainnet");
  });

  it("queryByTxHash scopes — a tx hash alone is not unique across chains", async () => {
    await db.queryByTxHash("abc123", "mainnet");
    expect(lastWhere("tokenTransfer", "findMany").network).toBe("mainnet");
  });

  it("getNftOwner scopes", async () => {
    await db.getNftOwner(CONTRACT, "1", "mainnet");
    expect(lastWhere("nftTransfer", "findFirst").network).toBe("mainnet");
  });
});

describe("cursors are per-network, not singletons", () => {
  it("getLastIndexedLedger keys on network instead of id = 1", async () => {
    await db.getLastIndexedLedger("mainnet");
    const where = lastWhere("indexerState", "findUnique");
    expect(where).toEqual({ network: "mainnet" });
    expect(where.id).toBeUndefined();
  });

  it("setLastIndexedLedger upserts the network row", async () => {
    await db.setLastIndexedLedger(999, "mainnet");
    const call = calls.find((c) => c.model === "indexerState" && c.op === "upsert")!;
    expect(call.args.where).toEqual({ network: "mainnet" });
    expect(call.args.create).toMatchObject({ network: "mainnet", lastIndexedLedger: 999 });
  });

  it("backfill cursor reads, writes and clears per network", async () => {
    await db.getBackfillCursor("mainnet");
    expect(lastWhere("backfillCursor", "findUnique")).toEqual({ network: "mainnet" });

    await db.setBackfillCursor({ startLedger: 1, endLedger: 9, nextLedger: 5 }, "mainnet");
    const upsert = calls.find((c) => c.model === "backfillCursor" && c.op === "upsert")!;
    expect(upsert.args.create).toMatchObject({ network: "mainnet", nextLedger: 5 });

    await db.clearBackfillCursor("mainnet");
    expect(lastWhere("backfillCursor", "deleteMany")).toEqual({ network: "mainnet" });
  });
});

describe("destructive operations cannot cross networks", () => {
  it("rollbackToLedger scopes all three deletes", async () => {
    // The dangerous case: ledger sequences are per-chain and testnet runs far
    // ahead, so an unscoped `ledger > target` would delete real mainnet rows
    // during a testnet reorg.
    await db.rollbackToLedger(500, "testnet");

    // lpShareTransfer included: a reorg must roll back LP-share rows too, and
    // scoped by network for the same reason the others are.
    for (const model of ["tokenTransfer", "nftTransfer", "hostFnLog", "lpShareTransfer"]) {
      const where = lastWhere(model, "deleteMany");
      expect(where.network).toBe("testnet");
      expect(where.ledger).toEqual({ gt: 500 });
    }
  });

  it("pruneOldTransfers scopes, so pruning testnet leaves mainnet history alone", async () => {
    await db.pruneOldTransfers("testnet");
    expect(lastWhere("tokenTransfer", "deleteMany").network).toBe("testnet");
  });
});

describe("writes stamp the network explicitly", () => {
  const record = {
    contractId: CONTRACT,
    eventType: "transfer",
    fromAddress: ADDR,
    toAddress: null,
    amount: "100",
    ledger: 10,
    ledgerClosedAt: new Date("2026-01-01T00:00:00Z"),
    txHash: "abc",
    eventId: "evt-1",
  };

  it("upsertTransfers sets network on every row rather than relying on the column default", async () => {
    await db.upsertTransfers([record, { ...record, eventId: "evt-2" }], "mainnet");
    const call = calls.find((c) => c.model === "tokenTransfer" && c.op === "createMany")!;
    expect(call.args.data).toHaveLength(2);
    for (const row of call.args.data) expect(row.network).toBe("mainnet");
  });

  it("upsertNftTransfers stamps the network", async () => {
    await db.upsertNftTransfers(
      [{ contractId: CONTRACT, tokenId: "1", fromAddress: null, toAddress: ADDR, ledger: 1, ledgerClosedAt: new Date(), txHash: "t", eventId: "n-1" } as any],
      "mainnet"
    );
    const call = calls.find((c) => c.model === "nftTransfer" && c.op === "createMany")!;
    expect(call.args.data[0].network).toBe("mainnet");
  });

  it("NFT metadata is keyed by the compound (network, contractId, tokenId)", async () => {
    await db.getNftMetadata(CONTRACT, "7", "mainnet");
    expect(lastWhere("nftMetadata", "findUnique")).toEqual({
      network_contractId_tokenId: { network: "mainnet", contractId: CONTRACT, tokenId: "7" },
    });
  });
});

describe("raw SQL carries the network predicate", () => {
  it("querySummary passes the network as a bound parameter", async () => {
    // Raw SQL bypasses Prisma's where-builder entirely, so this is the path
    // most likely to be missed — and it aggregates balances.
    await db.querySummary({ address: ADDR, network: "mainnet" });
    expect(rawValues()).toContain("mainnet");
  });

  it("queryPopularAssets scopes both the count and the page", async () => {
    await db.queryPopularAssets({ fromDate: new Date(0), by: "volume", limit: 10, offset: 0, network: "mainnet" });
    // Two statements run: the DISTINCT count and the grouped page. If only one
    // were scoped, `total` would disagree with the rows returned.
    expect(raw).toHaveLength(2);
    for (const statement of raw) expect(statement.values).toContain("mainnet");
  });

  it("upsertAccountSummaries binds the network into the INSERT", async () => {
    await db.upsertAccountSummaries(
      [{ ...record_(), fromAddress: ADDR, toAddress: null }],
      "mainnet"
    );
    expect(rawValues()).toContain("mainnet");
  });

  function record_() {
    return {
      contractId: CONTRACT,
      eventType: "transfer",
      fromAddress: ADDR,
      toAddress: null,
      amount: "100",
      ledger: 10,
      ledgerClosedAt: new Date("2026-01-01T00:00:00Z"),
      txHash: "abc",
      eventId: "evt-1",
    };
  }
});
