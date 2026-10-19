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
