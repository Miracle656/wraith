import request from "supertest";
import { Prisma } from "@prisma/client";
import { createApp } from "../../api";
import { prisma } from "../../db";
import { createOfframpOrder } from "../../linq/client";

jest.mock("../../linq/client", () => ({
  ...jest.requireActual("../../linq/client"),
  createOfframpOrder: jest.fn(),
  getOfframpStatus: jest.fn(),
}));

jest.mock("../../db", () => {
  const actual = jest.requireActual("../../db");
  return {
    ...actual,
    prisma: {
      offrampOrder: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    },
  };
});

const mockedCreateOfframpOrder = createOfframpOrder as jest.MockedFunction<typeof createOfframpOrder>;
const mockPrisma = prisma as unknown as { offrampOrder: { findUnique: jest.Mock, create: jest.Mock } };

describe("Offramp route handlers", () => {
  const app = createApp();

  beforeEach(() => {
    process.env.LINQ_API_KEY = "test_key";
    jest.clearAllMocks();
  });

  afterAll(() => {
    delete process.env.LINQ_API_KEY;
  });

  const validBody = {
    amountNGN: 5000,
    bankAccount: "1234567890",
    bankCode: "033",
    bankName: "UBA",
    accountName: "John Doe",
    walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    idempotencyKey: "idem-key-123",
  };

  const validOrder = {
    id: "order-123",
    walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    chain: "stellar",
    coin: "usdc",
    coinType: "crypto",
    amountStableCoin: 5,
    amountNGN: 5000,
    rate: 1000,
    currency: "NGN",
    status: "initiated",
  };

  describe("POST /offramp/orders", () => {
    it("returns 201 on happy path", async () => {
      mockPrisma.offrampOrder.findUnique.mockResolvedValueOnce(null);
      mockedCreateOfframpOrder.mockResolvedValueOnce(validOrder);
      mockPrisma.offrampOrder.create.mockResolvedValueOnce({
        ...validOrder,
        orderId: validOrder.id,
      });

      const res = await request(app).post("/offramp/orders").send(validBody);

      expect(res.status).toBe(201);
      expect(res.body).toEqual(validOrder);
      expect(mockPrisma.offrampOrder.create).toHaveBeenCalled();
    });

    it("returns 200 replayed: true if order exists (replay)", async () => {
      mockPrisma.offrampOrder.findUnique.mockResolvedValueOnce({
        orderId: validOrder.id,
        depositAddress: validOrder.walletAddress,
        chain: validOrder.chain,
        coin: validOrder.coin,
        amountStableCoin: "5",
        amountNGN: "5000",
        rate: "1000",
        status: validOrder.status,
      });

      const res = await request(app).post("/offramp/orders").send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.replayed).toBe(true);
      expect(res.body.id).toBe(validOrder.id);
      expect(mockedCreateOfframpOrder).not.toHaveBeenCalled();
    });

    it("returns 200 not 500 on concurrent duplicate (P2002)", async () => {
      mockPrisma.offrampOrder.findUnique
        .mockResolvedValueOnce(null) // First check misses
        .mockResolvedValueOnce({ // Fallback fetch finds it
          orderId: validOrder.id,
          depositAddress: validOrder.walletAddress,
          chain: validOrder.chain,
          coin: validOrder.coin,
          amountStableCoin: "5",
          amountNGN: "5000",
          rate: "1000",
          status: validOrder.status,
        });

      mockedCreateOfframpOrder.mockResolvedValueOnce(validOrder);

      const p2002Error = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "5.10.0",
      });
      mockPrisma.offrampOrder.create.mockRejectedValueOnce(p2002Error);

      const res = await request(app).post("/offramp/orders").send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.replayed).toBe(true);
      expect(res.body.id).toBe(validOrder.id);
      expect(mockPrisma.offrampOrder.create).toHaveBeenCalled();
    });

    it("returns 400 on bad amount (e.g., 'abc')", async () => {
      const res = await request(app).post("/offramp/orders").send({
        ...validBody,
        amountNGN: "abc",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid amount");
      expect(mockedCreateOfframpOrder).not.toHaveBeenCalled();
    });

    it("returns 400 on negative amount", async () => {
      const res = await request(app).post("/offramp/orders").send({
        ...validBody,
        amountNGN: -100,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid amount");
    });
  });
});
