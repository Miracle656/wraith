/**
 * Ingest path parity (#203).
 *
 * `INGEST_WORKERS > 1` used to switch to a parallel path that silently skipped
 * NFT transfers, NFT metadata, LP shares, host-fn logs, SAC tagging, token
 * metadata and account summaries. Nothing errored; the data just stopped
 * arriving. The deliverable here is the comparison itself: the same events
 * pushed through the single-fetch path and the sharded path must leave
 * identical rows behind.
 *
 * The db layer is replaced by an in-memory store so this stays a unit test.
 * The fake event source honours the contract filter it is given, which is what
 * makes a path that forgets to request the NFT contract lose its events.
 */

import { StrKey, Address, nativeToScVal } from "@stellar/stellar-sdk";
import type { RawEvent } from "../rpc";

type Row = Record<string, unknown>;

// `mock`-prefixed so jest's hoisting allows the factories below to close over it.
const mockStore = {
  transfers: new Map<string, Row>(),
  nftTransfers: new Map<string, Row>(),
  nftMetadata: new Map<string, Row>(),
  summaries: new Map<string, { received: bigint; sent: bigint; txCount: number }>(),
  hostFn: new Map<string, Row>(),
  lp: new Map<string, Row>(),
  tokenMetadataLookups: new Set<string>(),
  cursor: 0,
};

function mockResetStore() {
  mockStore.transfers.clear();
  mockStore.nftTransfers.clear();
  mockStore.nftMetadata.clear();
  mockStore.summaries.clear();
  mockStore.hostFn.clear();
  mockStore.lp.clear();
  mockStore.tokenMetadataLookups.clear();
  mockStore.cursor = 0;
}

jest.mock("../db", () => ({
  prisma: {},
  getLastIndexedLedger: jest.fn(async () => null),
  setLastIndexedLedger: jest.fn(async (n: number) => { mockStore.cursor = n; }),
  pruneOldTransfers: jest.fn(async () => 0),
  upsertTransfers: jest.fn(async (records: Row[]) => {
    let added = 0;
    for (const r of records) {
      if (mockStore.transfers.has(String(r.eventId))) continue;
      mockStore.transfers.set(String(r.eventId), { ...r });
      added++;
    }
    return added;
  }),
  // Aggregated per (address, contract), so the result does not depend on the
  // order or grouping of batches, only on which records reached it.
  upsertAccountSummaries: jest.fn(async (records: Row[]) => {
    for (const r of records) {
      for (const [address, side] of [[r.toAddress, "in"], [r.fromAddress, "out"]] as const) {
        if (!address) continue;
        const key = `${address}:${r.contractId}`;
        const s = mockStore.summaries.get(key) ?? { received: 0n, sent: 0n, txCount: 0 };
        if (side === "in") s.received += BigInt(String(r.amount));
        else s.sent += BigInt(String(r.amount));
        s.txCount++;
        mockStore.summaries.set(key, s);
      }
    }
  }),
  upsertNftTransfers: jest.fn(async (records: Row[]) => {
    let added = 0;
    for (const r of records) {
      if (mockStore.nftTransfers.has(String(r.eventId))) continue;
      mockStore.nftTransfers.set(String(r.eventId), { ...r });
      added++;
    }
    return added;
  }),
  getNftMetadata: jest.fn(async (contractId: string, tokenId: string) =>
    mockStore.nftMetadata.get(`${contractId}:${tokenId}`) ?? null),
  upsertNftMetadata: jest.fn(async (contractId: string, tokenId: string, meta: Row) => {
    mockStore.nftMetadata.set(`${contractId}:${tokenId}`, { contractId, tokenId, ...meta });
  }),
}));

jest.mock("../indexer/host-fn-log", () => ({
  ...jest.requireActual("../indexer/host-fn-log"),
  upsertHostFnLogs: jest.fn(async (rows: Row[]) => {
    for (const r of rows) mockStore.hostFn.set(String(r.eventId), { ...r, args: JSON.stringify(r.args), result: JSON.stringify(r.result), gasUsed: null });
  }),
}));

jest.mock("../indexer/lp-shares", () => ({
  ...jest.requireActual("../indexer/lp-shares"),
  loadKnownLpPools: jest.fn(async () => []),
  upsertLpShareTransfers: jest.fn(async (rows: Row[]) => {
    let added = 0;
    for (const r of rows) {
      if (mockStore.lp.has(String(r.eventId))) continue;
      mockStore.lp.set(String(r.eventId), { ...r });
      added++;
    }
    return added;
  }),
}));

// SAC detection would hit RPC. Tag deterministically instead, still mutating
// the records so a path that skips tagging leaves a visible difference.
jest.mock("../indexer/sac-detect", () => ({
  tagSacTransfers: jest.fn(async (records: Array<{ contractId: string; isSac?: boolean }>) => {
    for (const r of records) r.isSac = r.contractId === mockSacA;
  }),
}));
let mockSacA = "";

jest.mock("../tokenCache", () => ({
  initTokenCache: jest.fn(async () => undefined),
  getTokenMetadata: jest.fn(async (contractId: string) => {
    mockStore.tokenMetadataLookups.add(contractId);
    return undefined;
  }),
}));

jest.mock("../ingester/nft", () => ({
  ...jest.requireActual("../ingester/nft"),
  fetchNftMetadata: jest.fn(async (contractId: string) => ({ name: `name-of-${contractId.slice(-4)}` })),
}));

import * as batch from "../indexer/batch";
import { pollParallel } from "../indexer/parallel";
import { createLoopState, ingestWindow, type LoopState } from "../indexer";

// ─── Fixtures (all strkeys built from raw bytes, so valid by construction) ────
const contract = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const account = (n: number) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n));

const SAC_A = contract(1);
const SAC_B = contract(2);
const POOL = contract(3);
const NFT_C = contract(4);
const ADMIN = contract(5);
const ALICE = account(1);
const BOB = account(2);
mockSacA = SAC_A;

let seq = 0;
function ev(contractId: string, ledger: number, topic: RawEvent["topic"], value: RawEvent["value"]): RawEvent {
  seq++;
  return {
    id: `${String(ledger).padStart(19, "0")}-${String(seq).padStart(5, "0")}`,
    type: "contract",
    ledger,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    contractId,
    txHash: `tx-${seq}`,
    topic,
    value,
  };
}
const sym = (s: string) => nativeToScVal(s, { type: "symbol" });
const addr = (a: string) => Address.fromString(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

const EVENTS: RawEvent[] = [
  ev(SAC_A, 10, [sym("transfer"), addr(ALICE), addr(BOB)], i128(100n)),
  ev(SAC_B, 11, [sym("transfer"), addr(BOB), addr(ALICE)], i128(50n)),
  ev(SAC_B, 12, [sym("mint"), addr(ADMIN), addr(ALICE)], i128(70n)),
  ev(NFT_C, 13, [sym("transfer"), addr(ALICE), addr(BOB), nativeToScVal(42n, { type: "u128" })], nativeToScVal(null)),
  ev(NFT_C, 14, [sym("transfer"), addr(ALICE), addr(BOB), nativeToScVal(43n, { type: "u128" })], nativeToScVal(null)),
  ev(NFT_C, 15, [sym("transfer"), addr(BOB), addr(ALICE), nativeToScVal(42n, { type: "u128" })], nativeToScVal(null)),
  ev(POOL, 16, [sym("deposit"), addr(ALICE)], i128(1000n)),
];

function fakeSource(): LoopState["sourceSwitcher"] {
  return {
    // Honours the contract filter: an event for a contract that was not asked
    // for is never returned, exactly like the real RPC.
    fetchEvents: async (from: number, to: number, ids: string[]) => ({
      events: EVENTS.filter((e) => ids.includes(e.contractId) && e.ledger >= from && e.ledger <= to),
      highestLedger: to,
    }),
    getLatestLedger: async () => 1000,
  } as unknown as LoopState["sourceSwitcher"];
}

function newLoop(): LoopState {
  process.env.SAC_CONTRACT_IDS_TESTNET = [SAC_A, SAC_B, POOL].join(",");
  process.env.NFT_CONTRACT_IDS_TESTNET = NFT_C;
  const loop = createLoopState("testnet");
  loop.sourceSwitcher = fakeSource();
  return loop;
}

/** Everything a path leaves behind, in a comparable, order-independent form. */
function snapshot() {
  const sorted = (m: Map<string, unknown>) =>
    [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    transfers: sorted(mockStore.transfers),
    nftTransfers: sorted(mockStore.nftTransfers),
    nftMetadata: sorted(mockStore.nftMetadata),
    summaries: sorted(mockStore.summaries as unknown as Map<string, unknown>),
    hostFn: sorted(mockStore.hostFn),
    lp: sorted(mockStore.lp),
    tokenMetadataLookups: [...mockStore.tokenMetadataLookups].sort(),
    cursor: mockStore.cursor,
  };
}

beforeEach(() => {
  mockResetStore();
  seq = 0;
});

describe("ingest path parity", () => {
  it("fixtures are valid strkeys", () => {
    for (const c of [SAC_A, SAC_B, POOL, NFT_C, ADMIN]) expect(StrKey.isValidContract(c)).toBe(true);
    for (const a of [ALICE, BOB]) expect(StrKey.isValidEd25519PublicKey(a)).toBe(true);
  });

  it("the single path indexes every record type from the fixture", async () => {
    const loop = newLoop();
    await ingestWindow(loop, 1, 100, 1);
    const s = snapshot();

    expect(s.transfers).toHaveLength(3);
    expect(s.nftTransfers).toHaveLength(3);
    expect(s.nftMetadata).toHaveLength(2); // tokens 42 and 43, de-duplicated
    expect(s.summaries.length).toBeGreaterThan(0);
    expect(s.hostFn).toHaveLength(EVENTS.length);
    expect(s.lp).toHaveLength(1);
    expect(s.tokenMetadataLookups).toEqual([SAC_A, SAC_B].sort());
    expect(s.cursor).toBe(100);
  });

  it("INGEST_WORKERS > 1 leaves identical TokenTransfer, NftTransfer, AccountSummary (and every other) rows", async () => {
    const single = newLoop();
    await ingestWindow(single, 1, 100, 1);
    const singleSnap = snapshot();
    const singleIndexed = single.totalIndexed;

    mockResetStore();
    const sharded = newLoop();
    await ingestWindow(sharded, 1, 100, 4);

    expect(snapshot()).toEqual(singleSnap);
    expect(sharded.totalIndexed).toBe(singleIndexed);
  });

  it("both paths run the events through the same processEventBatch", async () => {
    const spy = jest.spyOn(batch, "processEventBatch");

    await ingestWindow(newLoop(), 1, 100, 1);
    const singleCalls = spy.mock.calls.length;
    expect(singleCalls).toBeGreaterThan(0);

    spy.mockClear();
    mockResetStore();
    await ingestWindow(newLoop(), 1, 100, 4);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    // Every event ends up in exactly one batch, on either path.
    const seen = spy.mock.calls.flatMap((c) => c[0].map((e) => e.id)).sort();
    expect(seen).toEqual(EVENTS.map((e) => e.id).sort());

    spy.mockRestore();
  });

  it("the comparison is sensitive: a sharded path that skips a step is caught", async () => {
    const single = newLoop();
    await ingestWindow(single, 1, 100, 1);
    const singleSnap = snapshot();

    // Emulate the old bug: a worker pool whose batch handler only stores
    // fungible transfers.
    mockResetStore();
    const loop = newLoop();
    await pollParallel(loop.allContractIds, 1, 100, 10_000, 4, "testnet", {
      fetchEvents: (from, to, ids, limit) => loop.sourceSwitcher.fetchEvents(from, to, ids, limit),
      processBatch: async (events) => {
        const { upsertTransfers } = jest.requireMock("../db");
        const { parseEvents } = jest.requireActual("../decoder");
        const n = await upsertTransfers(parseEvents(events));
        return { fungibleInserted: n, nftInserted: 0, lpInserted: 0 };
      },
    });

    const drifted = snapshot();
    expect(drifted.nftTransfers).not.toEqual(singleSnap.nftTransfers);
    expect(drifted.summaries).not.toEqual(singleSnap.summaries);
    expect(drifted).not.toEqual(singleSnap);
  });
});
