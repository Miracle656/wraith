import { xdr, Address, nativeToScVal } from "@stellar/stellar-sdk";
import {
  isNftEvent,
  isNftMintOrBurnEvent,
  isNftTransferEvent,
  parseNftEvents,
  parseNftTransferEvent,
} from "../ingester/nft";
import type { RawEvent } from "../rpc";

/**
 * A minted NFT was invisible to this indexer until somebody transferred it on.
 *
 * `stellar-tokens` emits a mint as two topics with the token id in the data,
 * where a transfer is four topics with the id in a topic. The recogniser
 * required four, so Veil Names and Veil-ians — both of which mint straight to
 * the buyer and are usually never transferred — produced nothing to index, and
 * their holders were shown an empty gallery over a token the chain had already
 * recorded.
 */
const ALICE = "GDWCO35QUYQLGO6P7OLW4BZWNMMGGUWNPLRVPLCBVG7YNVDZKUDIW4KN";
const BOB = "GCXOO7OIJZ2HEOZODLOEISNVO6CBPK4PISRJCZYRFT37H7XGHDLB3C7O";
const CONTRACT = "CBC42KFZO33TYVFDOUXFRWXYYXHFGH7W5GM4IJQSXKGFINKL2XPP4XTE";

const COMMON: Omit<RawEvent, "topic" | "value"> = {
  id: "0000000000000000001-00001",
  type: "contract",
  ledger: 100,
  ledgerClosedAt: "2026-11-10T00:00:00Z",
  contractId: CONTRACT,
  txHash: "abc123txhash",
};

/** `topics = (Symbol("mint"), Address(to)), data = u32(token_id)` */
function mintEvent(to = BOB, tokenId = 9): RawEvent {
  return {
    ...COMMON,
    topic: [nativeToScVal("mint", { type: "symbol" }), Address.fromString(to).toScVal()],
    value: nativeToScVal(tokenId, { type: "u32" }),
  };
}

/** `topics = (Symbol("burn"), Address(from)), data = u32(token_id)` */
function burnEvent(from = BOB, tokenId = 9): RawEvent {
  return {
    ...COMMON,
    topic: [nativeToScVal("burn", { type: "symbol" }), Address.fromString(from).toScVal()],
    value: nativeToScVal(tokenId, { type: "u32" }),
  };
}

/** A FUNGIBLE burn: same shape, `i128` amount instead of a `u32` token id. */
function fungibleBurnEvent(): RawEvent {
  return {
    ...COMMON,
    topic: [nativeToScVal("burn", { type: "symbol" }), Address.fromString(BOB).toScVal()],
    value: nativeToScVal(1_000_000_000n, { type: "i128" }),
  };
}

/** A FUNGIBLE mint: three topics, `(mint, admin, to)`, i128 amount. */
function fungibleMintEvent(): RawEvent {
  return {
    ...COMMON,
    topic: [
      nativeToScVal("mint", { type: "symbol" }),
      Address.fromString(ALICE).toScVal(),
      Address.fromString(BOB).toScVal(),
    ],
    value: nativeToScVal(1_000_000_000n, { type: "i128" }),
  };
}

function transferEvent(tokenId = 7n): RawEvent {
  return {
    ...COMMON,
    topic: [
      nativeToScVal("transfer", { type: "symbol" }),
      Address.fromString(ALICE).toScVal(),
      Address.fromString(BOB).toScVal(),
      nativeToScVal(tokenId, { type: "u128" }),
    ],
    value: xdr.ScVal.scvVoid(),
  };
}

describe("NFT mint and burn are recognised", () => {
  it("records a mint as a holding with no sender", () => {
    const record = parseNftTransferEvent(mintEvent(BOB, 9));
    expect(record).not.toBeNull();
    expect(record!.fromAddress).toBeNull();
    expect(record!.toAddress).toBe(BOB);
    expect(record!.tokenId).toBe("9");
    expect(record!.contractId).toBe(CONTRACT);
  });

  it("records a burn as a departure with no recipient", () => {
    const record = parseNftTransferEvent(burnEvent(BOB, 9));
    expect(record!.fromAddress).toBe(BOB);
    expect(record!.toAddress).toBeNull();
    expect(record!.tokenId).toBe("9");
  });

  it("still parses an ordinary transfer", () => {
    const record = parseNftTransferEvent(transferEvent(7n));
    expect(record!.fromAddress).toBe(ALICE);
    expect(record!.toAddress).toBe(BOB);
    expect(record!.tokenId).toBe("7");
  });

  it("takes the token id from the data on a mint and the topic on a transfer", () => {
    // The two live in different places, and reading the wrong one yields a
    // plausible number rather than an error.
    const parsed = parseNftEvents([mintEvent(BOB, 9), transferEvent(7n)]);
    expect(parsed.map((p) => p.record.tokenId)).toEqual(["9", "7"]);
    expect(parsed.map((p) => p.tokenIdScVal.switch().name)).toEqual(["scvU32", "scvU128"]);
  });
});

describe("fungible events are not claimed as NFTs", () => {
  it("ignores a fungible burn, which has the same two-topic shape", () => {
    // Only the data type tells them apart: a token id is u32, an amount i128.
    // Matching on the symbol alone would file every fungible burn on the chain
    // as an NFT movement.
    expect(isNftMintOrBurnEvent(fungibleBurnEvent())).toBe(false);
    expect(isNftEvent(fungibleBurnEvent())).toBe(false);
    expect(parseNftTransferEvent(fungibleBurnEvent())).toBeNull();
  });

  it("ignores a fungible mint", () => {
    expect(isNftEvent(fungibleMintEvent())).toBe(false);
  });

  it("leaves the transfer predicate meaning exactly what it did", () => {
    // `isNftTransferEvent` is still the four-topic test; the split in
    // `processEventBatch` depends on the broader one, not this.
    expect(isNftTransferEvent(mintEvent())).toBe(false);
    expect(isNftTransferEvent(transferEvent())).toBe(true);
  });
});

describe("malformed events never throw", () => {
  it.each([
    ["no topics", { ...COMMON, topic: [], value: xdr.ScVal.scvVoid() }],
    [
      "mint with a non-address party",
      {
        ...COMMON,
        topic: [nativeToScVal("mint", { type: "symbol" }), nativeToScVal(1, { type: "u32" })],
        value: nativeToScVal(9, { type: "u32" }),
      },
    ],
    [
      "mint with no data",
      {
        ...COMMON,
        topic: [nativeToScVal("mint", { type: "symbol" }), Address.fromString(BOB).toScVal()],
        value: xdr.ScVal.scvVoid(),
      },
    ],
  ])("%s", (_label, raw) => {
    expect(() => isNftEvent(raw as RawEvent)).not.toThrow();
    expect(isNftEvent(raw as RawEvent)).toBe(false);
    expect(parseNftTransferEvent(raw as RawEvent)).toBeNull();
  });
});
