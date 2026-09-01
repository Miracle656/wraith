import {
  getTokenMetadata,
  initTokenCache,
  getAllCachedTokens,
  _resetTokenCache,
} from "../tokenCache";
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
    network: "testnet" as const,
    contractId: "C123",
    symbol: "TKN",
    name: "Token",
    decimals: 7,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // The cache is module-level state and survives between tests. Clearing it
    // keeps each case independent — otherwise a "hit" in one test can be
    // satisfied by a value some earlier test happened to leave behind.
    _resetTokenCache();
    (prisma.tokenMetadata.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.tokenMetadata.findUnique as jest.Mock).mockResolvedValue(null);
  });

  it("populates cache from DB on init", async () => {
    (prisma.tokenMetadata.findMany as jest.Mock).mockResolvedValue([mockToken]);

    await initTokenCache("testnet");

    expect(prisma.tokenMetadata.findMany).toHaveBeenCalledWith({
      where: { network: "testnet" },
    });
    expect(getAllCachedTokens()).toContainEqual(mockToken);
  });

  it("returns cached metadata without an RPC call", async () => {
    (prisma.tokenMetadata.findMany as jest.Mock).mockResolvedValue([mockToken]);
    await initTokenCache("testnet");

    const result = await getTokenMetadata("C123", "testnet");

    expect(result).toEqual(mockToken);
    expect(fetchTokenMetadata).not.toHaveBeenCalled();
  });

  it("fetches from RPC and persists to DB on cache miss", async () => {
    (fetchTokenMetadata as jest.Mock).mockResolvedValue({
      symbol: "NEW",
      name: "New Token",
      decimals: 9,
    });

    const result = await getTokenMetadata("C456", "testnet");

    expect(result.symbol).toBe("NEW");
    expect(fetchTokenMetadata).toHaveBeenCalledWith("C456", "testnet");
    expect(prisma.tokenMetadata.upsert).toHaveBeenCalledWith({
      where: { network_contractId: { network: "testnet", contractId: "C456" } },
      create: expect.objectContaining({ symbol: "NEW", network: "testnet" }),
      update: expect.objectContaining({ symbol: "NEW", network: "testnet" }),
    });
  });

  it("does not serve one network's token for the same id on another", async () => {
    // A contract id is only unique within a chain. Sharing a cache entry across
    // networks would serve the wrong symbol and, far worse, the wrong
    // `decimals` — silently rescaling every amount rendered from that token.
    (prisma.tokenMetadata.findMany as jest.Mock).mockResolvedValue([mockToken]);
    await initTokenCache("testnet");

    (fetchTokenMetadata as jest.Mock).mockResolvedValue({
      symbol: "MAIN",
      name: "Mainnet Token",
      decimals: 2,
    });

    const result = await getTokenMetadata("C123", "mainnet");

    expect(result.symbol).toBe("MAIN");
    expect(result.decimals).toBe(2);
    expect(fetchTokenMetadata).toHaveBeenCalledWith("C123", "mainnet");
  });

  it("asks the RPC for the same network it caches the answer under", async () => {
    // Querying the wrong chain returns nothing or a different token, and that
    // answer would then be cached under the network that was asked for.
    (fetchTokenMetadata as jest.Mock).mockResolvedValue({
      symbol: "X",
      name: "X",
      decimals: 7,
    });

    await getTokenMetadata("CXYZ", "mainnet");

    expect(fetchTokenMetadata).toHaveBeenCalledWith("CXYZ", "mainnet");
    expect(getAllCachedTokens("mainnet")).toHaveLength(1);
    expect(getAllCachedTokens("testnet")).toHaveLength(0);
  });

  it("narrows getAllCachedTokens to one network when asked", async () => {
    (prisma.tokenMetadata.findMany as jest.Mock).mockResolvedValue([mockToken]);
    await initTokenCache("testnet");

    (fetchTokenMetadata as jest.Mock).mockResolvedValue({
      symbol: "M",
      name: "M",
      decimals: 7,
    });
    await getTokenMetadata("CMAIN", "mainnet");

    expect(getAllCachedTokens()).toHaveLength(2);
    expect(getAllCachedTokens("testnet").map((t) => t.contractId)).toEqual(["C123"]);
    expect(getAllCachedTokens("mainnet").map((t) => t.contractId)).toEqual(["CMAIN"]);
  });

  it("keeps serving from RPC when the DB seed fails", async () => {
    // A cold cache is recoverable; refusing to start is not.
    (prisma.tokenMetadata.findMany as jest.Mock).mockRejectedValue(new Error("db down"));
    (fetchTokenMetadata as jest.Mock).mockResolvedValue({
      symbol: "OK",
      name: "OK",
      decimals: 7,
    });

    await expect(initTokenCache("testnet")).resolves.toBeUndefined();
    await expect(getTokenMetadata("CANY", "testnet")).resolves.toMatchObject({ symbol: "OK" });
  });
});
