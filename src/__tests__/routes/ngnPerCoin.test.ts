/**
 * Which side of Linq's book each rail quotes from.
 *
 * This sits below the route tests on purpose. Those mock `ngnPerCoin` whole, so
 * they can prove the offramp asks for the right *coin* and cannot see which
 * provider endpoint the answer came from — which is exactly where the money bug
 * lived: `/offramp/rate` served `/onramprate`, the buy side, for weeks. Quoting
 * 1,478.55 while the payout settled at 1,371.58 is a 7.2% shortfall that every
 * screen repeated until the receipt replaced it with the real number.
 */
import { __clearNgnRateCache, ngnPerCoin } from "../../api/ngn";

jest.mock("../../linq/onramp", () => {
  const actual = jest.requireActual("../../linq/onramp");
  return { ...actual, getOnrampRate: jest.fn() };
});
jest.mock("../../linq/client", () => {
  const actual = jest.requireActual("../../linq/client");
  return { ...actual, getRate: jest.fn() };
});
jest.mock("../../linq/coinPrice", () => {
  const actual = jest.requireActual("../../linq/coinPrice");
  return { ...actual, usdPerCoin: jest.fn() };
});

import { getOnrampRate } from "../../linq/onramp";
import { getRate } from "../../linq/client";
import { usdPerCoin } from "../../linq/coinPrice";

const mockBuyRate = getOnrampRate as jest.Mock;
const mockSellRate = getRate as jest.Mock;
const mockUsd = usdPerCoin as jest.Mock;

// The two sides, as measured on 2026-10-27.
const BUY = 1478.55;
const SELL = 1371.58;

beforeEach(() => {
  __clearNgnRateCache();
  mockBuyRate.mockReset().mockResolvedValue(BUY);
  mockSellRate.mockReset().mockResolvedValue({ rate: SELL, currency: "NGN", coin: "USDC" });
  mockUsd.mockReset().mockImplementation(async (coin: string) => (coin === "usdc" ? 1 : 0.175));
});

describe("ngnPerCoin — the rail picks the side of the book", () => {
  it("prices a cash-out from the sell rate, not the buy rate", async () => {
    await expect(ngnPerCoin("usdc", "offramp")).resolves.toBeCloseTo(SELL, 6);
    expect(mockSellRate).toHaveBeenCalled();
    expect(mockBuyRate).not.toHaveBeenCalled();
  });

  it("prices a purchase from the buy rate", async () => {
    await expect(ngnPerCoin("usdc", "onramp")).resolves.toBeCloseTo(BUY, 6);
    expect(mockBuyRate).toHaveBeenCalled();
    expect(mockSellRate).not.toHaveBeenCalled();
  });

  it("quotes the two rails differently for the same coin", async () => {
    const [buy, sell] = [
      await ngnPerCoin("usdc", "onramp"),
      await ngnPerCoin("usdc", "offramp"),
    ];
    expect(buy).not.toBeCloseTo(sell, 0);
  });

  it("still converts units, so XLM is priced per XLM on both rails", async () => {
    await expect(ngnPerCoin("xlm", "offramp")).resolves.toBeCloseTo(SELL * 0.175, 6);
    await expect(ngnPerCoin("xlm", "onramp")).resolves.toBeCloseTo(BUY * 0.175, 6);
  });

  it("caches each rail separately, so a buy quote cannot answer a sell", async () => {
    await ngnPerCoin("usdc", "onramp");
    // Warm cache on one rail must not satisfy the other.
    await expect(ngnPerCoin("usdc", "offramp")).resolves.toBeCloseTo(SELL, 6);
    expect(mockSellRate).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure", async () => {
    mockSellRate.mockRejectedValueOnce(new Error("provider down"));
    await expect(ngnPerCoin("usdc", "offramp")).rejects.toThrow();
    await expect(ngnPerCoin("usdc", "offramp")).resolves.toBeCloseTo(SELL, 6);
  });
});
