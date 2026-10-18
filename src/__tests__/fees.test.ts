/**
 * What Veil charges, and how it scales.
 *
 * The fee was a flat amount, and the numbers were stark: 0.1 USDC is 10% of a
 * 1 USDC send and 0.01% of a 1,000 one. The people being onboarded with a
 * thousand naira paid the heaviest rate while large senders paid nothing worth
 * naming. These pin the proportional version, and in particular the two things
 * that decide whether a fee is honest — which way it rounds, and what a client
 * too old to say what it is sending gets told.
 */

import { configuredFees, feeForAmount } from "../api/fees";

const DESTINATION = "GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const FEE_ENV = [
  "VEIL_FEE_DESTINATION",
  "VEIL_FEE_ASSET_CODE",
  "VEIL_FEE_ASSET_ISSUER",
  "VEIL_FEE_AMOUNT",
  "VEIL_FEE_AMOUNT_XLM",
  "VEIL_FEE_PERCENT",
  "VEIL_FEE_MIN",
  "VEIL_FEE_MAX",
  "VEIL_FEE_MIN_XLM",
  "VEIL_FEE_MAX_XLM",
];

beforeEach(() => {
  for (const key of FEE_ENV) delete process.env[key];
  process.env.VEIL_FEE_DESTINATION = DESTINATION;
  process.env.VEIL_FEE_ASSET_ISSUER = ISSUER;
});

afterAll(() => {
  for (const key of FEE_ENV) delete process.env[key];
});

describe("feeForAmount", () => {
  it("scales with what is being sent", () => {
    const policy = { percent: 10, min: null, max: null };
    expect(feeForAmount(1, policy)).toBe("0.1");
    expect(feeForAmount(10, policy)).toBe("1");
    expect(feeForAmount(100, policy)).toBe("10");
  });

  // Rounding decides who absorbs the remainder, and on a charge the user did
  // not ask for it should not be them.
  it("rounds down, never up", () => {
    // 0.5% of 3.33333335 is 0.016666666…, which does not fit in seven places.
    expect(feeForAmount(3.33333335, { percent: 0.5, min: null, max: null })).toBe("0.0166666");
  });

  it("never charges below the floor", () => {
    // 0.5% of 1 is 0.005, under a 0.02 minimum.
    expect(feeForAmount(1, { percent: 0.5, min: 0.02, max: null })).toBe("0.02");
  });

  it("never charges above the cap", () => {
    expect(feeForAmount(100_000, { percent: 0.5, min: null, max: 1 })).toBe("1");
  });

  // Rounding down can take a tiny fee to zero; the floor is applied after, so
  // a configured fee can never silently vanish.
  it("applies the floor after rounding, so a fee cannot round away", () => {
    expect(feeForAmount(0.0000001, { percent: 0.5, min: 0.01, max: null })).toBe("0.01");
  });

  // "1000.0000000" with its trailing zeros stripped must not become "1".
  it("keeps whole numbers that end in zero intact", () => {
    expect(feeForAmount(10_000, { percent: 10, min: null, max: null })).toBe("1000");
    expect(feeForAmount(200, { percent: 10, min: null, max: null })).toBe("20");
  });
});

describe("configuredFees", () => {
  it("stays flat when no rate is configured", () => {
    process.env.VEIL_FEE_AMOUNT = "0.1";

    // Same answer whatever is being sent — the behaviour before this existed.
    expect(configuredFees(1)["USDC"]).toMatchObject({ amount: "0.1" });
    expect(configuredFees(1000)["USDC"]).toMatchObject({ amount: "0.1" });
    expect(configuredFees()["USDC"]).toMatchObject({ amount: "0.1" });
  });

  it("prices against the amount when a rate is configured", () => {
    process.env.VEIL_FEE_PERCENT = "0.5";
    process.env.VEIL_FEE_MIN = "0.02";
    process.env.VEIL_FEE_MAX = "5";

    expect(configuredFees(1)["USDC"]).toMatchObject({ amount: "0.02", percent: "0.5" });
    expect(configuredFees(100)["USDC"]).toMatchObject({ amount: "0.5" });
    expect(configuredFees(100_000)["USDC"]).toMatchObject({ amount: "5" });
  });

  // The shipped APKs ask without an amount and charge whatever comes back, so
  // this is what they will take. The floor is the smallest honest number:
  // undercharging costs us, overcharging costs the user.
  it("answers with the floor when the caller cannot say what it is sending", () => {
    process.env.VEIL_FEE_PERCENT = "0.5";
    process.env.VEIL_FEE_MIN = "0.02";

    expect(configuredFees()["USDC"]).toMatchObject({ amount: "0.02" });
  });

  it("falls back to the flat amount as the floor when no minimum is set", () => {
    process.env.VEIL_FEE_PERCENT = "0.5";
    process.env.VEIL_FEE_AMOUNT = "0.1";

    expect(configuredFees()["USDC"]).toMatchObject({ amount: "0.1" });
    // 0.5% of 100 is 0.5, comfortably above the 0.1 floor.
    expect(configuredFees(100)["USDC"]).toMatchObject({ amount: "0.5" });
  });

  it("prices XLM on its own floor and cap", () => {
    process.env.VEIL_FEE_PERCENT = "0.5";
    process.env.VEIL_FEE_AMOUNT_XLM = "0.5";
    process.env.VEIL_FEE_MAX_XLM = "20";

    expect(configuredFees(1)["XLM"]).toMatchObject({ amount: "0.5" });
    expect(configuredFees(100_000)["XLM"]).toMatchObject({ amount: "20" });
  });

  // A rate over 100% would take more than the user is sending.
  it.each([["0"], ["-1"], ["101"], ["abc"]])("ignores an impossible rate (%s)", (percent) => {
    process.env.VEIL_FEE_PERCENT = percent;
    process.env.VEIL_FEE_AMOUNT = "0.1";

    // Falls back to flat rather than charging something indefensible.
    expect(configuredFees(1000)["USDC"]).toMatchObject({ amount: "0.1" });
    expect(configuredFees(1000)["USDC"]?.percent).toBeUndefined();
  });

  it("charges nothing without a destination", () => {
    delete process.env.VEIL_FEE_DESTINATION;
    process.env.VEIL_FEE_PERCENT = "0.5";
    process.env.VEIL_FEE_AMOUNT = "0.1";

    expect(configuredFees(100)).toEqual({});
  });
});
