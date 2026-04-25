import { getTokenMetadata, initTokenCache, getAllCachedTokens } from "../tokenCache";
import { prisma } from "../db";
import { fetchTokenMetadata } from "../rpc";

jest.mock("../db", () => ({
  prisma: {
    tokenMetadata: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));

jest.mock("../rpc", () => ({
  fetchTokenMetadata: jest.fn(),
}));

describe("Token Cache", () => {
  const mockToken = {
    contractId: "C123",
    symbol: "TKN",
    name: "Token",
    decimals: 7,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Clear the internal Map by some means? 
    // Since it's a module-level constant, I might need to reset it.
    // In tokenCache.ts I didn't export the cache map.
    // I'll just assume a fresh state or test transitions.
  });

  it("populates cache from DB on init", async () => {
    (prisma.tokenMetadata.findMany as jest.Mock).mockResolvedValue([mockToken]);
    
    await initTokenCache();
    
    expect(prisma.tokenMetadata.findMany).toHaveBeenCalled();
    expect(getAllCachedTokens()).toContainEqual(mockToken);
  });

  it("returns cached metadata without RPC call", async () => {
    // Manually inject into cache via init or previous call
    (prisma.tokenMetadata.findMany as jest.Mock).mockResolvedValue([mockToken]);
    await initTokenCache();

    const result = await getTokenMetadata("C123");
    
    expect(result).toEqual(mockToken);
    expect(fetchTokenMetadata).not.toHaveBeenCalled();
  });

  it("fetches from RPC and persists to DB on cache miss", async () => {
    (prisma.tokenMetadata.findUnique as jest.Mock).mockResolvedValue(null);
    (fetchTokenMetadata as jest.Mock).mockResolvedValue({
      symbol: "NEW",
      name: "New Token",
      decimals: 9,
    });

    const result = await getTokenMetadata("C456");
    
    expect(result.symbol).toBe("NEW");
    expect(fetchTokenMetadata).toHaveBeenCalledWith("C456");
    expect(prisma.tokenMetadata.upsert).toHaveBeenCalledWith({
      where: { contractId: "C456" },
      create: expect.objectContaining({ symbol: "NEW" }),
      update: expect.objectContaining({ symbol: "NEW" }),
    });
  });
});
