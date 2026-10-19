import { usdPerCoin, __clearCoinPriceCache } from "../../linq/coinPrice";

/**
 * Pricing a coin in dollars, and refusing to when it cannot be done.
 *
 * This module exists because both naira screens priced XLM as though one XLM
 * were one dollar — ₦1,000 bought 0.6 XLM instead of 3.6, and ₦500 of airtime
 * was paid for with 6 cents. So the tests that matter most here are the ones
 * asserting it throws: a wrong price that looks plausible is the failure this
 * code is for, and a fallback value would reintroduce it.
 */
describe("usdPerCoin", () => {
  const realFetch = global.fetch;

  const book = (bid: string, ask: string) => ({
    ok: true,
    json: async () => ({ bids: [{ price: bid }], asks: [{ price: ask }] }),
  });

  beforeEach(() => {
    __clearCoinPriceCache();
    global.fetch = jest.fn();
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it("prices USDC as a dollar without asking anyone", async () => {
    await expect(usdPerCoin("usdc")).resolves.toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("prices XLM at the mid of the book", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(book("0.1968071", "0.1970800"));
    await expect(usdPerCoin("xlm")).resolves.toBeCloseTo(0.19694355, 8);
  });

  it("caches, so a burst of users is not a burst at Horizon", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(book("0.20", "0.21"));
    await usdPerCoin("xlm");
    await usdPerCoin("xlm");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an empty book", { bids: [], asks: [] }],
    ["one side missing", { bids: [{ price: "0.2" }], asks: [] }],
    ["a crossed book", { bids: [{ price: "0.3" }], asks: [{ price: "0.2" }] }],
    ["a non-numeric price", { bids: [{ price: "oops" }], asks: [{ price: "0.2" }] }],
    ["a zero price", { bids: [{ price: "0" }], asks: [{ price: "0" }] }],
    ["an absurd price", { bids: [{ price: "500" }], asks: [{ price: "501" }] }],
  ])("refuses rather than guessing on %s", async (_label, payload) => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => payload });
    await expect(usdPerCoin("xlm")).rejects.toThrow(/price XLM/i);
  });

  it("refuses when Horizon errors", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(usdPerCoin("xlm")).rejects.toThrow(/price XLM/i);
  });

  it("refuses when Horizon is unreachable", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("network down"));
    await expect(usdPerCoin("xlm")).rejects.toThrow(/price XLM/i);
  });

  it("does not cache a failure", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("blip"));
    await expect(usdPerCoin("xlm")).rejects.toThrow();
    (global.fetch as jest.Mock).mockResolvedValue(book("0.19", "0.20"));
    await expect(usdPerCoin("xlm")).resolves.toBeCloseTo(0.195, 6);
  });
});
