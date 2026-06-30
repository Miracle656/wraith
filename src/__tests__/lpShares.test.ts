/**
 * Tests for the LP-share transfer indexer.
 *
 * Covers the two event dialects (explicit deposit/withdraw and bare SEP-41
 * mint/burn of the pool's own share token), share extraction from both bare
 * i128 and map-wrapped values, the pure decoder, batch filtering, and the
 * idempotent insert path. No network is used; the Prisma client is mocked for
 * the persistence test, mirroring the tombstones test style.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { xdr, Address, nativeToScVal } from "@stellar/stellar-sdk";

// Mock the Prisma client before importing the module so `upsertLpShareTransfers`
// exercises a fake `createMany`.
const createMany = jest.fn<
  (args: { data: unknown[]; skipDuplicates: boolean }) => Promise<{ count: number }>
>();
jest.mock("../db", () => ({
  prisma: { lpShareTransfer: { createMany } },
}));

import {
  isLpShareEvent,
  extractShares,
  parseLpShareEvent,
  parseLpShareEvents,
  upsertLpShareTransfers,
  type LpShareTransferRecord,
} from "../indexer/lp-shares";
import type { RawEvent } from "../rpc";

// ─── Fixtures ───────────────────────────────────────────────────────────────
const ALICE = "GDWCO35QUYQLGO6P7OLW4BZWNMMGGUWNPLRVPLCBVG7YNVDZKUDIW4KN";
const BOB = "GCXOO7OIJZ2HEOZODLOEISNVO6CBPK4PISRJCZYRFT37H7XGHDLB3C7O";
const POOL = "CBC42KFZO33TYVFDOUXFRWXYYXHFGH7W5GM4IJQSXKGFINKL2XPP4XTE";
// A second valid contract address to stand in for a pool's admin in mint events.
const POOL_ADMIN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const COMMON: Omit<RawEvent, "topic" | "value"> = {
  id: "0000000000000000001-00001",
  type: "contract",
  ledger: 100,
  ledgerClosedAt: "2024-01-01T00:00:00Z",
  contractId: POOL,
  txHash: "abc123txhash",
};

/** Explicit AMM deposit: topics=[Symbol("deposit"), Address(provider)], value=i128(shares). */
function makeDepositEvent(shares: bigint = 1_000n, id = COMMON.id): RawEvent {
  return {
    ...COMMON,
    id,
    topic: [nativeToScVal("deposit", { type: "symbol" }), Address.fromString(ALICE).toScVal()],
    value: nativeToScVal(shares, { type: "i128" }),
  };
}

/** Explicit AMM withdraw: topics=[Symbol("withdraw"), Address(provider)], value=i128(shares). */
function makeWithdrawEvent(shares: bigint = 500n, id = "0000000000000000001-00002"): RawEvent {
  return {
    ...COMMON,
    id,
    topic: [nativeToScVal("withdraw", { type: "symbol" }), Address.fromString(BOB).toScVal()],
    value: nativeToScVal(shares, { type: "i128" }),
  };
}

/** SEP-41 share mint: topics=[Symbol("mint"), Address(admin), Address(to)], value=i128. */
function makeShareMintEvent(shares: bigint = 750n, id = "0000000000000000001-00003"): RawEvent {
  return {
    ...COMMON,
    id,
    topic: [
      nativeToScVal("mint", { type: "symbol" }),
      Address.fromString(POOL_ADMIN).toScVal(),
      Address.fromString(ALICE).toScVal(),
    ],
    value: nativeToScVal(shares, { type: "i128" }),
  };
}

/** SEP-41 share burn: topics=[Symbol("burn"), Address(from)], value=i128. */
function makeShareBurnEvent(shares: bigint = 250n, id = "0000000000000000001-00004"): RawEvent {
  return {
    ...COMMON,
    id,
    topic: [nativeToScVal("burn", { type: "symbol" }), Address.fromString(ALICE).toScVal()],
    value: nativeToScVal(shares, { type: "i128" }),
  };
}

/** A non-LP event (plain swap) that must be ignored. */
function makeSwapEvent(): RawEvent {
  return {
    ...COMMON,
    id: "0000000000000000001-00099",
    topic: [nativeToScVal("swap", { type: "symbol" }), Address.fromString(ALICE).toScVal()],
    value: nativeToScVal(1n, { type: "i128" }),
  };
}

beforeEach(() => {
  createMany.mockReset();
});

// ─── extractShares ────────────────────────────────────────────────────────────
describe("extractShares", () => {
  it("reads a bare i128 value", () => {
    expect(extractShares(nativeToScVal(1_234n, { type: "i128" }))).toBe("1234");
  });

  it("returns the absolute value (shares are never negative)", () => {
    expect(extractShares(nativeToScVal(-99n, { type: "i128" }))).toBe("99");
  });

  it("preserves precision for very large amounts", () => {
    const big = 2n ** 100n + 7n;
    expect(extractShares(nativeToScVal(big, { type: "i128" }))).toBe(big.toString());
  });

  it("digs the amount out of a map-wrapped value by share_amount", () => {
    const val = nativeToScVal(
      { share_amount: 4_200n, amount_a: 1n, amount_b: 2n },
      { type: { share_amount: ["symbol", "i128"], amount_a: ["symbol", "i128"], amount_b: ["symbol", "i128"] } }
    );
    expect(extractShares(val)).toBe("4200");
  });

  it("falls back to the `amount` key when no share-specific key exists", () => {
    const val = nativeToScVal({ amount: 88n }, { type: { amount: ["symbol", "i128"] } });
    expect(extractShares(val)).toBe("88");
  });

  it("returns null when no amount can be found", () => {
    expect(extractShares(xdr.ScVal.scvVoid())).toBeNull();
  });
});

// ─── isLpShareEvent ────────────────────────────────────────────────────────────
describe("isLpShareEvent", () => {
  it("accepts an explicit deposit", () => {
    expect(isLpShareEvent(makeDepositEvent())).toBe(true);
  });

  it("accepts an explicit withdraw", () => {
    expect(isLpShareEvent(makeWithdrawEvent())).toBe(true);
  });

  it("accepts a SEP-41 share mint and burn", () => {
    expect(isLpShareEvent(makeShareMintEvent())).toBe(true);
    expect(isLpShareEvent(makeShareBurnEvent())).toBe(true);
  });

  it("rejects an unrelated event symbol", () => {
    expect(isLpShareEvent(makeSwapEvent())).toBe(false);
  });

  it("rejects an empty topics array", () => {
    expect(isLpShareEvent({ ...COMMON, topic: [], value: xdr.ScVal.scvVoid() })).toBe(false);
  });

  it("rejects a deposit with no decodable share amount", () => {
    const ev: RawEvent = {
      ...COMMON,
      topic: [nativeToScVal("deposit", { type: "symbol" }), Address.fromString(ALICE).toScVal()],
      value: xdr.ScVal.scvVoid(),
    };
    expect(isLpShareEvent(ev)).toBe(false);
  });

  it("rejects a mint with no recipient topic", () => {
    const ev: RawEvent = {
      ...COMMON,
      topic: [nativeToScVal("mint", { type: "symbol" }), Address.fromString(POOL_ADMIN).toScVal()],
      value: nativeToScVal(1n, { type: "i128" }),
    };
    expect(isLpShareEvent(ev)).toBe(false);
  });
});

// ─── parseLpShareEvent ─────────────────────────────────────────────────────────
describe("parseLpShareEvent", () => {
  it("decodes a deposit as shares minted to the provider, tagged with the pool", () => {
    const r = parseLpShareEvent(makeDepositEvent(1_000n));
    expect(r).not.toBeNull();
    expect(r?.poolId).toBe(POOL);
    expect(r?.action).toBe("deposit");
    expect(r?.fromAddress).toBeNull();
    expect(r?.toAddress).toBe(ALICE);
    expect(r?.shares).toBe("1000");
    expect(r?.ledger).toBe(100);
    expect(r?.txHash).toBe("abc123txhash");
    expect(r?.eventId).toBe(COMMON.id);
    expect(r?.ledgerClosedAt).toBeInstanceOf(Date);
  });

  it("decodes a withdraw as shares burned from the provider", () => {
    const r = parseLpShareEvent(makeWithdrawEvent(500n));
    expect(r?.action).toBe("withdraw");
    expect(r?.fromAddress).toBe(BOB);
    expect(r?.toAddress).toBeNull();
    expect(r?.shares).toBe("500");
    expect(r?.poolId).toBe(POOL);
  });

  it("decodes a SEP-41 share mint to the recipient (topics[2]), not the admin", () => {
    const r = parseLpShareEvent(makeShareMintEvent(750n));
    expect(r?.action).toBe("deposit");
    expect(r?.toAddress).toBe(ALICE);
    expect(r?.fromAddress).toBeNull();
    expect(r?.shares).toBe("750");
  });

  it("decodes a SEP-41 share burn from the holder (topics[1])", () => {
    const r = parseLpShareEvent(makeShareBurnEvent(250n));
    expect(r?.action).toBe("withdraw");
    expect(r?.fromAddress).toBe(ALICE);
    expect(r?.toAddress).toBeNull();
    expect(r?.shares).toBe("250");
  });

  it("returns null for an unrelated event", () => {
    expect(parseLpShareEvent(makeSwapEvent())).toBeNull();
  });

  it("never throws on a malformed event", () => {
    const ev: RawEvent = {
      ...COMMON,
      topic: [nativeToScVal("deposit", { type: "symbol" }), xdr.ScVal.scvVoid()],
      value: nativeToScVal(1n, { type: "i128" }),
    };
    expect(parseLpShareEvent(ev)).toBeNull();
  });
});

// ─── parseLpShareEvents ────────────────────────────────────────────────────────
describe("parseLpShareEvents", () => {
  it("extracts only LP events from a mixed batch", () => {
    const batch: RawEvent[] = [
      makeDepositEvent(10n, "id-001"),
      makeSwapEvent(),
      makeWithdrawEvent(20n, "id-002"),
    ];
    const records = parseLpShareEvents(batch);
    expect(records).toHaveLength(2);
    expect(records[0].action).toBe("deposit");
    expect(records[1].action).toBe("withdraw");
  });

  it("returns an empty array when there are no LP events", () => {
    expect(parseLpShareEvents([makeSwapEvent()])).toHaveLength(0);
  });

  it("returns an empty array for an empty batch", () => {
    expect(parseLpShareEvents([])).toHaveLength(0);
  });
});

// ─── upsertLpShareTransfers ────────────────────────────────────────────────────
describe("upsertLpShareTransfers", () => {
  it("bulk-inserts idempotently, skipping duplicates", async () => {
    createMany.mockResolvedValue({ count: 2 });
    const records = parseLpShareEvents([makeDepositEvent(1n, "a"), makeWithdrawEvent(2n, "b")]);

    const inserted = await upsertLpShareTransfers(records);

    expect(inserted).toBe(2);
    expect(createMany).toHaveBeenCalledWith({ data: records, skipDuplicates: true });
  });

  it("skips the DB entirely for an empty batch", async () => {
    const inserted = await upsertLpShareTransfers([]);
    expect(inserted).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("returns the count reported by the database", async () => {
    createMany.mockResolvedValue({ count: 1 });
    const records: LpShareTransferRecord[] = parseLpShareEvents([makeDepositEvent(5n, "dup")]);
    expect(await upsertLpShareTransfers(records)).toBe(1);
  });
});
