import { crossCheckWebhookAmount, isNairaAmountPlausible, nairaScale, checkNairaAmount } from "../amount";
import { toDisplayAmount } from "../amount";

describe("toDisplayAmount", () => {
  it("uses a token's real decimals", () => {
    expect(toDisplayAmount("1000000", 6)).toBe("1.000000");
    expect(toDisplayAmount("1234567", 6)).toBe("1.234567");
  });

  it("preserves the historical 7-decimal output by default", () => {
    expect(toDisplayAmount("10000000")).toBe("1.0000000");
    expect(toDisplayAmount("1")).toBe("0.0000001");
    expect(toDisplayAmount("-10000000")).toBe("-1.0000000");
  });

  it("supports zero decimals", () => {
    expect(toDisplayAmount("42", 0)).toBe("42");
  });
});

// -----------------------------------------------------------------------------
// Naira scale pinning tests.
//
// Background: on 2026-10-14 the provider reported that onramp naira
// amounts on their dashboard, and `amountNGN` in their webhooks, had been
// 100x too small, and that it was now corrected. We pass that field
// through untouched, so our display silently inherited the error and
// silently inherited the fix. Nothing in this service would have
// noticed either. These tests pin the expected scale so a future
// scale change fails closely instead of silently inheriting.
// -----------------------------------------------------------------------------

const WEBHOOK_PAYLOAD = {
  event: "order.completed",
  data: {
    orderId: "ord_01HXXZXXXXXXXXXXXXXXXXXXX",
    amountNGN: 2000000,
    status: "completed",
  },
};

const ORDER_AMOUNT_NGN = 20000;

const FIFTY_NGN = 50;

describe("naira scale", () => {
  it("pins the provider scale to kobo (1 NGN = 100 kobo)", () => {
    expect(nairaScale()).toBe(100);
  });

  it("rejects the 100x too-small webhook amount from the 2026-10-14 report", () => {
    const buggy = {
      ...WEBHOOK_PAYLOAD,
      data: { ...WEBHOOK_PAYLOAD.data, amountNGN: 2000000 / 100 },
    };

    const result = crossCheckWebhookAmount(buggy.data.amountNGN, ORDER_AMOUNT_NGN);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/scale/i);
  });

  it("accepts the corrected webhook amount from the same shape", () => {
    const result = crossCheckWebhookAmount(
      WEBHOOK_PAYLOAD.data.amountNGN,
      ORDER_AMOUNT_NGN,
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a ₦50 airtime top-up order amount", () => {
    const result = crossCheckWebhookAmount(FIFTY_NGN * 100, FIFTY_NGN);
    expect(result.ok).toBe(true);
  });

  it("accepts a corrected ₦50 webhook amount matching the order", () => {
    const result = crossCheckWebhookAmount(FIFTY_NGN * 100, FIFTY_NGN);
    expect(result.ok).toBe(true);
  });

  it("flags an amount that is implausible for the order", () => {
    expect(isNairaAmountPlausible(2000000000)).toBe(false);
  });

  it("rejects a negative or non-integer naira amount", () => {
    expect(isNairaAmountPlausible(-1)).toBe(false);
    expect(isNairaAmountPlausible(1.5)).toBe(false);
  });

  it("rejects zero naira amount as nonsense", () => {
    expect(isNairaAmountPlausible(0)).toBe(false);
  });

  it("checkNairaAmount returns a flag rather than throwing for out-of-range values", () => {
    const result = checkNairaAmount(20000000000);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("crossCheckWebhookAmount catches 100x scale discrepancy", () => {
    const buggyWebhookAmount = ORDER_AMOUNT_NGN;

    const result = crossCheckWebhookAmount(buggyWebhookAmount, ORDER_AMOUNT_NGN);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/scale|100x/i);
  });

  it("crossCheckWebhookAmount allows matching amounts", () => {
    const result = crossCheckWebhookAmount(ORDER_AMOUNT_NGN * 100, ORDER_AMOUNT_NGN);
    expect(result.ok).toBe(true);
  });
});