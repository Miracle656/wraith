import request from "supertest";
import { createApp } from "../../api";
import { queryBalances } from "../../db";

// Mock the DB module
jest.mock("../../db", () => ({
  ...jest.requireActual("../../db"),
  queryBalances: jest.fn(),
  prisma: { $queryRaw: jest.fn() },
}));

const mockQueryBalances = queryBalances as jest.MockedFunction<typeof queryBalances>;

describe("Accounts route handlers", () => {
  const app = createApp();

  describe("GET /accounts/:address/balance", () => {
    const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

    beforeEach(() => {
      mockQueryBalances.mockReset();
    });

    it("returns per-token derived balance for a known address", async () => {
      mockQueryBalances.mockResolvedValue([
        { contractId: CONTRACT_A, balance: "50000000" }, // 5.0000000
      ]);

      const res = await request(app).get(`/accounts/${ALICE}/balance`);

      expect(res.status).toBe(200);
      expect(res.body.balances).toHaveLength(1);
      expect(res.body.balances[0]).toEqual({
        contractId: CONTRACT_A,
        balance: "50000000",
        displayBalance: "5.0000000",
      });
      expect(res.body.derivedFromLedger).toBe(true);
    });

    it("returns the raw stroop amount alongside the display value", async () => {
      // Returning only the display string would force every consumer to parse
      // a decimal back to an integer to do arithmetic on it, guessing the
      // scale on the way.
      mockQueryBalances.mockResolvedValue([{ contractId: CONTRACT_A, balance: "1" }]);

      const res = await request(app).get(`/accounts/${ALICE}/balance`);

      expect(res.body.balances[0].balance).toBe("1");
      expect(res.body.balances[0].displayBalance).toBe("0.0000001");
    });

    it("returns an empty balances array for an unknown address", async () => {
      mockQueryBalances.mockResolvedValue([]);

      const res = await request(app).get(`/accounts/GUNKNOWN/balance`);

      expect(res.status).toBe(200);
      expect(res.body.balances).toHaveLength(0);
    });

    it("says the figure is derived, not read from chain", async () => {
      // Part of the contract, not decoration: this is a sum over the indexed
      // window, so it reads low for an address that held tokens before the
      // start ledger. A caller that mistakes it for an on-chain balance read
      // will be wrong in a way the numbers themselves do not reveal.
      mockQueryBalances.mockResolvedValue([]);

      const res = await request(app).get(`/accounts/${ALICE}/balance`);

      expect(res.body).toHaveProperty("derivedFromLedger", true);
      expect(res.body.note).toMatch(/not read from chain/i);
    });

    it("scopes the query to the selected network", async () => {
      // Summing two chains' transfers for one address produces a figure that
      // corresponds to no balance anywhere.
      mockQueryBalances.mockResolvedValue([]);

      const res = await request(app)
        .get(`/accounts/${ALICE}/balance`)
        .query({ network: "testnet" });

      expect(res.status).toBe(200);
      expect(mockQueryBalances).toHaveBeenCalledWith(ALICE, "testnet");
      expect(res.body.network).toBe("testnet");
    });

    it("rejects a network this deployment does not serve, without querying", async () => {
      const res = await request(app)
        .get(`/accounts/${ALICE}/balance`)
        .query({ network: "mainnet" });

      expect(res.status).toBe(400);
      expect(mockQueryBalances).not.toHaveBeenCalled();
    });
  });
});
