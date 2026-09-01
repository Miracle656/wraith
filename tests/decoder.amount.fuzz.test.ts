import fc from "fast-check";
import { xdr, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { parseEvent } from "../src/decoder";
import type { RawEvent } from "../src/rpc";
import * as fixtures from "../src/__tests__/fixtures/events.json";

const I128_MAX = 170141183460469231731687303715884105727n;
const I128_MIN = -170141183460469231731687303715884105728n;

// JavaScript Number loses integer precision beyond ±2^53-1.
// Any i128 value outside this band will silently corrupt if handled as a number.
const JS_MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER); //  9_007_199_254_740_991n
const JS_MIN_SAFE = -BigInt(Number.MAX_SAFE_INTEGER); // -9_007_199_254_740_991n

const aliceScVal = xdr.ScVal.fromXDR(fixtures.transfer.topic[1], "base64");
const bobScVal   = xdr.ScVal.fromXDR(fixtures.transfer.topic[2], "base64");

const baseEvent = {
  ledger:         1,
  ledgerClosedAt: "2024-01-01T00:00:00Z",
  contractId:     fixtures.contractId,
  txHash:         "fuzz000000000000000000000000000000000000000000000000000000000001",
  id:             "0000000000000000001-00001",
  type:           "contract",
} as const;

function makeTransferEvent(amountScVal: xdr.ScVal): RawEvent {
  return {
    ...baseEvent,
    topic: [xdr.ScVal.scvSymbol("transfer"), aliceScVal, bobScVal],
    value: amountScVal,
  };
}

// Generator: full i128 range, with 2× weight on the unsafe-for-Number band so
// precision bugs surface quickly without excluding the in-range sub-domain.
const arbI128 = fc.oneof(
  { arbitrary: fc.bigInt({ min: JS_MAX_SAFE + 1n, max: I128_MAX }),   weight: 2 },
  { arbitrary: fc.bigInt({ min: I128_MIN, max: JS_MIN_SAFE - 1n }),   weight: 2 },
  { arbitrary: fc.bigInt({ min: I128_MIN, max: I128_MAX }),           weight: 1 },
);

describe("decoder amount fuzz – BigInt-only precision", () => {
  it("stellar-sdk scValToNative returns bigint (not number) for i128 ScVals", () => {
    // Verify the SDK invariant that decodeI128 relies on.  If this ever starts
    // returning a number, every amount outside the safe-integer range silently
    // loses precision before we even reach the decoder.
    const sentinels = [
      0n,
      1n,
      -1n,
      JS_MAX_SAFE,
      JS_MAX_SAFE + 1n,
      JS_MIN_SAFE,
      JS_MIN_SAFE - 1n,
      I128_MAX,
      I128_MIN,
    ];
    for (const v of sentinels) {
      const native = scValToNative(nativeToScVal(v, { type: "i128" }));
      expect(typeof native).toBe("bigint");
    }
  });

  it("10 000 i128 inputs decode with no precision loss", () => {
    fc.assert(
      fc.property(arbI128, (original) => {
        const amountScVal = nativeToScVal(original, { type: "i128" });
        const raw = makeTransferEvent(amountScVal);
        const result = parseEvent(raw);

        // Decoder must recognise the transfer event
        expect(result).not.toBeNull();

        // Decoder encodes amount as a decimal string for storage
        expect(typeof result!.amount).toBe("string");

        // No precision loss: BigInt round-trip must be exact.
        // If the decoder had fallen through to the `number` path, values
        // outside ±2^53-1 would stringify with rounding, and this would fail.
        expect(BigInt(result!.amount)).toBe(original);
      }),
      { numRuns: 10_000 },
    );
  });
});
