import { xdr, Address, nativeToScVal } from "@stellar/stellar-sdk";
import {
  isNftTransferEvent,
  parseNftTransferEvent,
  parseNftEvents,
} from "../ingester/nft";
import type { RawEvent } from "../rpc";

// ─── Test addresses (reuse fixtures from decoder tests) ───────────────────────
const ALICE = "GDWCO35QUYQLGO6P7OLW4BZWNMMGGUWNPLRVPLCBVG7YNVDZKUDIW4KN";
const BOB   = "GCXOO7OIJZ2HEOZODLOEISNVO6CBPK4PISRJCZYRFT37H7XGHDLB3C7O";
const CONTRACT = "CBC42KFZO33TYVFDOUXFRWXYYXHFGH7W5GM4IJQSXKGFINKL2XPP4XTE";

const COMMON: Omit<RawEvent, "topic" | "value"> = {
  id: "0000000000000000001-00001",
  type: "contract",
  ledger: 100,
  ledgerClosedAt: "2024-01-01T00:00:00Z",
  contractId: CONTRACT,
  txHash: "abc123txhash",
};

/**
 * Build a CAP-46 NFT transfer RawEvent:
 *   topics = [Symbol("transfer"), Address(from), Address(to), u128(tokenId)]
 *   value  = void
 */
function makeNftEvent(tokenId: bigint = 42n, id = COMMON.id): RawEvent {
  return {
    ...COMMON,
    id,
    topic: [
      nativeToScVal("transfer", { type: "symbol" }),
      Address.fromString(ALICE).toScVal(),
      Address.fromString(BOB).toScVal(),
      nativeToScVal(tokenId, { type: "u128" }),
    ],
    value: xdr.ScVal.scvVoid(),
  };
}

/**
 * Build a SEP-41 fungible transfer RawEvent:
 *   topics = [Symbol("transfer"), Address(from), Address(to)]
 *   value  = i128(amount)
 */
function makeFungibleEvent(): RawEvent {
  return {
    ...COMMON,
    id: "0000000000000000001-00099",
    topic: [
      nativeToScVal("transfer", { type: "symbol" }),
      Address.fromString(ALICE).toScVal(),
      Address.fromString(BOB).toScVal(),
    ],
    value: nativeToScVal(1_000_000_000n, { type: "i128" }),
  };
}

// ─── isNftTransferEvent ───────────────────────────────────────────────────────

describe("isNftTransferEvent", () => {
  it("returns true for 4-topic NFT transfer", () => {
    expect(isNftTransferEvent(makeNftEvent())).toBe(true);
  });

  it("returns false for 3-topic fungible transfer", () => {
    expect(isNftTransferEvent(makeFungibleEvent())).toBe(false);
  });

  it("returns false when symbol is not 'transfer'", () => {
    const ev: RawEvent = {
      ...COMMON,
      topic: [
        nativeToScVal("mint", { type: "symbol" }),
        Address.fromString(ALICE).toScVal(),
        Address.fromString(BOB).toScVal(),
        nativeToScVal(1n, { type: "u128" }),
      ],
      value: xdr.ScVal.scvVoid(),
    };
    expect(isNftTransferEvent(ev)).toBe(false);
  });

  it("returns false for an empty topics array", () => {
    const ev: RawEvent = { ...COMMON, topic: [], value: xdr.ScVal.scvVoid() };
    expect(isNftTransferEvent(ev)).toBe(false);
  });

  it("returns false when address topics have wrong ScVal type", () => {
    const ev: RawEvent = {
      ...COMMON,
      topic: [
        nativeToScVal("transfer", { type: "symbol" }),
        xdr.ScVal.scvVoid(), // not an address
        xdr.ScVal.scvVoid(),
        nativeToScVal(1n, { type: "u128" }),
      ],
      value: xdr.ScVal.scvVoid(),
    };
    expect(isNftTransferEvent(ev)).toBe(false);
  });
});

// ─── parseNftTransferEvent ────────────────────────────────────────────────────

describe("parseNftTransferEvent", () => {
  it("parses a u128 tokenId correctly", () => {
    const result = parseNftTransferEvent(makeNftEvent(42n));
    expect(result).not.toBeNull();
    expect(result?.contractId).toBe(CONTRACT);
    expect(result?.tokenId).toBe("42");
    expect(result?.fromAddress).toBe(ALICE);
    expect(result?.toAddress).toBe(BOB);
    expect(result?.ledger).toBe(100);
    expect(result?.txHash).toBe("abc123txhash");
    expect(result?.eventId).toBe(COMMON.id);
  });

  it("parses a large tokenId (u128 near-max)", () => {
    const big = 2n ** 64n + 99n;
    const result = parseNftTransferEvent(makeNftEvent(big));
    expect(result).not.toBeNull();
    expect(result?.tokenId).toBe(big.toString());
  });

  it("parses a string tokenId", () => {
    const ev: RawEvent = {
      ...COMMON,
      id: "0000000000000000001-00010",
      topic: [
        nativeToScVal("transfer", { type: "symbol" }),
        Address.fromString(ALICE).toScVal(),
        Address.fromString(BOB).toScVal(),
        nativeToScVal("my-nft-token", { type: "string" }),
      ],
      value: xdr.ScVal.scvVoid(),
    };
    const result = parseNftTransferEvent(ev);
    expect(result).not.toBeNull();
    expect(result?.tokenId).toBe("my-nft-token");
  });

  it("returns null for a fungible transfer (3 topics)", () => {
    expect(parseNftTransferEvent(makeFungibleEvent())).toBeNull();
  });

  it("sets ledgerClosedAt as a proper Date", () => {
    const result = parseNftTransferEvent(makeNftEvent());
    expect(result?.ledgerClosedAt).toBeInstanceOf(Date);
    expect(result?.ledgerClosedAt.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });
});

// ─── parseNftEvents ───────────────────────────────────────────────────────────

describe("parseNftEvents", () => {
  it("extracts only NFT events from a mixed batch", () => {
    const batch: RawEvent[] = [
      makeNftEvent(1n, "id-001"),
      makeFungibleEvent(),
      makeNftEvent(2n, "id-003"),
    ];
    const results = parseNftEvents(batch);
    expect(results).toHaveLength(2);
    expect(results[0].record.tokenId).toBe("1");
    expect(results[1].record.tokenId).toBe("2");
  });

  it("returns the tokenIdScVal alongside each record", () => {
    const [{ record, tokenIdScVal }] = parseNftEvents([makeNftEvent(99n)]);
    expect(record.tokenId).toBe("99");
    // tokenIdScVal must be the u128 ScVal from topic[3]
    expect(tokenIdScVal.switch()).toBe(xdr.ScValType.scvU128());
  });

  it("returns an empty array when the batch has no NFT events", () => {
    expect(parseNftEvents([makeFungibleEvent()])).toHaveLength(0);
  });

  it("returns an empty array for an empty batch", () => {
    expect(parseNftEvents([])).toHaveLength(0);
  });
});
