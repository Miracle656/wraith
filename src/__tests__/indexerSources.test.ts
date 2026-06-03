jest.mock("../rpc", () => ({
  getLatestLedger: jest.fn(),
  fetchEventsSafe: jest.fn(),
}));

import { createSourceSwitcherWithConfig } from "../indexer/sources";
import { getLatestLedger, fetchEventsSafe } from "../rpc";

const mockGetLatestLedger = getLatestLedger as jest.MockedFunction<typeof getLatestLedger>;
const mockFetchEventsSafe = fetchEventsSafe as jest.MockedFunction<typeof fetchEventsSafe>;

describe("Indexer source switcher", () => {
  beforeEach(() => {
    mockGetLatestLedger.mockReset();
    mockFetchEventsSafe.mockReset();
  });

  it("falls back to Horizon when RPC is unhealthy", async () => {
    mockGetLatestLedger.mockRejectedValue(new Error("rpc down"));

    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ _embedded: { records: [{ sequence: 123 }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          records: [
            {
              id: "evt-1",
              ledger: 122,
              ledgerCloseTime: "2025-01-01T00:00:00Z",
              contractId: "C123",
              txHash: "tx-1",
              topic: [],
              value: {},
            },
          ],
        }),
      });

    const switcher = createSourceSwitcherWithConfig({
      horizonUrl: "https://horizon.example",
      fetchImpl: fetchImpl as never,
    });
    const result = await switcher.fetchEvents(120, 123, ["C123"], 50);

    expect(result.highestLedger).toBe(122);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].contractId).toBe("C123");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(mockFetchEventsSafe).not.toHaveBeenCalled();
  });
});