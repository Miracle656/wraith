/**
 * List queries must not pay for a COUNT by default (#206).
 *
 * db.ts resolves its client from `globalThis.prisma`, so a recording stub keeps
 * this a unit test with no database. The assertions are about which calls were
 * issued (no `count` on the default path) and about the n+1 boundary that
 * replaces it, not about row contents.
 */
import { StrKey } from "@stellar/stellar-sdk";

type AnyRecord = Record<string, any>;

const ALICE = "GDWCO35QUYQLGO6P7OLW4BZWNMMGGUWNPLRVPLCBVG7YNVDZKUDIW4KN";
// Built from raw bytes so it is a valid strkey by construction.
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));

const calls: Array<{ model: string; op: string; args: AnyRecord }> = [];
let rows: AnyRecord[] = [];
let exactCount = 0;
let transactionCalls = 0;

const model = (name: string) =>
  new Proxy(
    {},
    {
      get: (_t, op: string) => (args: AnyRecord) => {
        calls.push({ model: name, op, args: args ?? {} });
        if (op === "count") return Promise.resolve(exactCount);
        if (op === "findMany") return Promise.resolve(rows.slice(0, args?.take ?? rows.length));
        return Promise.resolve(null);
      },
    }
  ) as AnyRecord;

const stub: AnyRecord = {
  tokenTransfer: model("tokenTransfer"),
  nftTransfer: model("nftTransfer"),
  accountSummary: model("accountSummary"),
  $transaction: (ops: unknown) => {
    transactionCalls++;
    return Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: AnyRecord) => unknown)(stub);
  },
};
(globalThis as AnyRecord).prisma = stub;

// Imported after the stub is installed — db.ts binds its client at module load.
import * as db from "../db";

const makeRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: n - i, ledger: 1000 + n - i, amount: "10000000" }));
const countCalls = () => calls.filter((c) => c.op === "count");

beforeEach(() => {
  calls.length = 0;
  rows = [];
  exactCount = 0;
  transactionCalls = 0;
});

it("fixtures are valid Stellar strkeys", () => {
  expect(StrKey.isValidEd25519PublicKey(ALICE)).toBe(true);
  expect(StrKey.isValidContract(CONTRACT)).toBe(true);
});

const listQueries: Array<[string, string, (extra?: AnyRecord) => Promise<AnyRecord>]> = [
  ["queryTransfers", "tokenTransfer", (e) => db.queryTransfers({ address: ALICE, direction: "incoming", ...e })],
  ["queryAllTransfers", "tokenTransfer", (e) => db.queryAllTransfers({ address: ALICE, ...e })],
  ["queryNftTransfers", "nftTransfer", (e) => db.queryNftTransfers({ contractId: CONTRACT, ...e })],
  ["queryAccountSummaries", "accountSummary", (e) => db.queryAccountSummaries({ address: ALICE, ...e })],
];

describe.each(listQueries)("%s", (_name, modelName, run) => {
  it("issues no COUNT by default and omits total", async () => {
    rows = makeRows(3);
    const result = await run({ limit: 10 });

    expect(countCalls()).toHaveLength(0);
    expect(transactionCalls).toBe(0);
    expect(calls.filter((c) => c.model === modelName && c.op === "findMany")).toHaveLength(1);
    expect(result).not.toHaveProperty("total");
  });

  it("reports hasMore=false and no cursor when the page is exactly full (boundary)", async () => {
    rows = makeRows(5); // limit 5 -> fetches 6, gets 5
    const result = await run({ limit: 5 });

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.transfers).toHaveLength(5);
  });

  it("reports hasMore=true with a cursor when one row exists past the page (boundary)", async () => {
    rows = makeRows(6); // limit 5 -> fetches 6, gets 6
    const result = await run({ limit: 5 });

    expect(calls.find((c) => c.op === "findMany")!.args.take).toBe(6); // n+1
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(result.transfers).toHaveLength(5);
  });

  it("returns an exact total only when includeTotal is requested", async () => {
    rows = makeRows(2);
    exactCount = 1234;
    const result = await run({ limit: 10, includeTotal: true });

    expect(countCalls()).toHaveLength(1);
    expect(countCalls()[0].model).toBe(modelName);
    expect(result.total).toBe(1234);
    expect(result.hasMore).toBe(false);
  });

  it("includeTotal=false behaves like the default", async () => {
    rows = makeRows(2);
    const result = await run({ limit: 10, includeTotal: false });
    expect(countCalls()).toHaveLength(0);
    expect(result).not.toHaveProperty("total");
  });
});
