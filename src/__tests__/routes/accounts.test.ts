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

    it("returns per-token derived balance for a known address", async () => {
      mockQueryBalances.mockResolvedValue([
        { contractId: CONTRACT_A, balance: "50000000" } // 5.0000000
      ]);

      const res = await request(app).get(`/accounts/${ALICE}/balance`);

      expect(res.status).toBe(200);
      expect(res.body.balances).toHaveLength(1);
      expect(res.body.balances[0]).toEqual({
        token: CONTRACT_A,
        balance: "5.0000000"
      });
      expect(res.body.derived_from_ledger).toBe(true);
    });

    it("returns empty balances array for unknown address", async () => {
      mockQueryBalances.mockResolvedValue([]);

      const res = await request(app).get(`/accounts/GUNKNOWN/balance`);

      expect(res.status).toBe(200);
      expect(res.body.balances).toHaveLength(0);
    });

    it("includes a derived_from_ledger field in the response", async () => {
        mockQueryBalances.mockResolvedValue([]);
        const res = await request(app).get(`/accounts/${ALICE}/balance`);
        expect(res.body).toHaveProperty("derived_from_ledger", true);
    });
  });
});
