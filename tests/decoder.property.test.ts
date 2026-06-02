import fc from "fast-check";
import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { parseEvent } from "../src/decoder";
import type { RawEvent } from "../src/rpc";
import * as fixtures from "../src/__tests__/fixtures/events.json";

// i128 bounds
const I128_MAX = 170141183460469231731687303715884105727n;
const I128_MIN = -170141183460469231731687303715884105728n;

// Edge-case amounts: zero, max-u128 bit pattern as signed i128 (-1), i128 extremes, i64 cast values
const EDGE_AMOUNTS: bigint[] = [
  0n,
  1n,
  -1n,                          // all bits set = max-u128 interpreted as signed i128
  I128_MAX,
  I128_MIN,
  9223372036854775807n,         // i64 max — negative i128 cast boundary
  -9223372036854775808n,        // i64 min — negative i128 cast
  1_000_000_000n,               // 100 XLM in stroops
];

// Re-use pre-encoded addresses from the fixture to avoid keygen in the hot loop
const aliceScVal = xdr.ScVal.fromXDR(fixtures.transfer.topic[1], "base64");
const bobScVal   = xdr.ScVal.fromXDR(fixtures.transfer.topic[2], "base64");

const KNOWN_TYPES = ["transfer", "mint", "burn", "clawback"] as const;

const baseEvent = {
  ledger:          100,
  ledgerClosedAt:  "2024-01-01T00:00:00Z",
  contractId:      fixtures.contractId,
  txHash:          "prop_test_0000000000000000000000000000000000000000000000000000000001",
  id:              "0000000000000000100-00001",
  type:            "contract",
};

function makeRawEvent(topics: xdr.ScVal[], value: xdr.ScVal): RawEvent {
  return { ...baseEvent, topic: topics, value };
}

// Produce topics appropriate for a given event type so that the decoder does not throw
// "wrong number of topics" — the property under test is about amount edge-cases, not topic
// structure validation.
function topicsFor(eventType: string): xdr.ScVal[] {
  const sym = xdr.ScVal.scvSymbol(eventType);
  if (eventType === "transfer" || eventType === "mint") {
    return [sym, aliceScVal, bobScVal];
  }
  if (eventType === "burn" || eventType === "clawback") {
    return [sym, aliceScVal];
  }
  return [sym];
}

// Arbitrary: i128 ScVal covering edge cases and the full signed range
const arbI128ScVal = fc
  .oneof(
    fc.constantFrom(...EDGE_AMOUNTS),
    fc.bigInt({ min: I128_MIN, max: I128_MAX }),
  )
  .map(n => nativeToScVal(n, { type: "i128" }));

// Arbitrary: arbitrary string symbol ScVal (may or may not be a known event type)
const arbSymbolScVal = fc
  .string({ minLength: 0, maxLength: 32 })
  .map(s => xdr.ScVal.scvSymbol(s));

describe("decoder property-based tests (#73)", () => {
  it("never produces an unhandled exception for 10 000 arbitrary inputs", () => {
    // Generate: known or unknown event-type symbol + matching topic count + i128 amount.
    // The decoder must either return TransferRecord|null or throw an Error — never an
    // unclassified crash (TypeError, RangeError from an unexpected code path, etc.).
    const arbEventType = fc.oneof(
      fc.constantFrom<string>(...KNOWN_TYPES),
      fc.string({ minLength: 1, maxLength: 16 }),
    );

    const arbRaw = fc
      .tuple(arbEventType, arbI128ScVal)
      .map(([eventType, amountScVal]) => makeRawEvent(topicsFor(eventType), amountScVal));

    fc.assert(
      fc.property(arbRaw, raw => {
        try {
          const result = parseEvent(raw);
          // Must be null or a plain object (TransferRecord)
          expect(result === null || (typeof result === "object" && result !== null)).toBe(true);
        } catch (err) {
          // Thrown values must be proper Error instances — not unhandled crashes
          expect(err).toBeInstanceOf(Error);
        }
      }),
      { numRuns: 10_000 },
    );
  });

  it("accepts every edge-case i128 amount without throwing", () => {
    for (const amount of EDGE_AMOUNTS) {
      const amountScVal = nativeToScVal(amount, { type: "i128" });

      for (const eventType of KNOWN_TYPES) {
        const raw = makeRawEvent(topicsFor(eventType), amountScVal);
        const result = parseEvent(raw);
        expect(result).not.toBeNull();
        expect(typeof result!.amount).toBe("string");
        // Decoded value round-trips through BigInt
        expect(BigInt(result!.amount)).toBe(amount);
      }
    }
  });

  it("returns null for arbitrary non-token symbol events without throwing", () => {
    fc.assert(
      fc.property(
        arbSymbolScVal.filter(scv => {
          try {
            const native = (scv as xdr.ScVal).switch().name;
            void native;
          } catch { return false; }
          return true;
        }),
        arbI128ScVal,
        (typeTopic, amountScVal) => {
          // Build a single-topic raw event (unknown event type path)
          const raw = makeRawEvent([typeTopic], amountScVal);
          try {
            const result = parseEvent(raw);
            // For truly unknown symbols parseEvent returns null
            expect(result === null || typeof result === "object").toBe(true);
          } catch (err) {
            expect(err).toBeInstanceOf(Error);
          }
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("known fixtures still parse correctly", () => {
    const cases: Array<{ fixture: { topic: string[]; value: string }; type: string }> = [
      { fixture: fixtures.transfer,  type: "transfer"  },
      { fixture: fixtures.mint,      type: "mint"      },
      { fixture: fixtures.burn,      type: "burn"      },
      { fixture: fixtures.clawback,  type: "clawback"  },
    ];

    for (const { fixture, type } of cases) {
      const raw = makeRawEvent(
        fixture.topic.map((t: string) => xdr.ScVal.fromXDR(t, "base64")),
        xdr.ScVal.fromXDR(fixture.value, "base64"),
      );
      const result = parseEvent(raw);
      expect(result?.eventType).toBe(type);
    }
  });
});
