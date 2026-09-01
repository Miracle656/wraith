/**
 * Multi-network indexer tests (#161, #160).
 *
 * The acceptance criteria are about *isolation*, and isolation bugs are quiet:
 * two loops sharing a counter still index correctly, they just report nonsense;
 * two loops sharing an RPC client still fetch events, just from one chain. So
 * these assert that per-network things are actually distinct, rather than that
 * the code runs.
 */

import {
  DEFAULT_XLM_SAC_MAINNET,
  DEFAULT_XLM_SAC_TESTNET,
  getIndexerStats,
  resolveNftContractIds,
  resolveSacContractIds,
  runningNetworks,
  _resetIndexerLoops,
} from "../indexer";
import { getRpc, validateNetworkConfig, _resetRpcClients } from "../rpc";
import { currentNetwork, enabledNetworks, parseNetwork } from "../network";

const ENV_KEYS = [
  "NETWORKS",
  "STELLAR_NETWORK",
  "SAC_CONTRACT_IDS",
  "SAC_CONTRACT_IDS_TESTNET",
  "SAC_CONTRACT_IDS_MAINNET",
  "CONTRACT_IDS",
  "NFT_CONTRACT_IDS",
  "NFT_CONTRACT_IDS_TESTNET",
  "NFT_CONTRACT_IDS_MAINNET",
  "SOROBAN_RPC_URL",
  "STELLAR_RPC_URL",
  "SOROBAN_RPC_URL_TESTNET",
  "SOROBAN_RPC_URL_MAINNET",
];

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  _resetRpcClients();
  _resetIndexerLoops();
});

describe("enabledNetworks", () => {
  it("defaults to the single configured network, so existing deployments are unchanged", () => {
    expect(enabledNetworks()).toEqual(["testnet"]);

    process.env.STELLAR_NETWORK = "mainnet";
    expect(enabledNetworks()).toEqual(["mainnet"]);
  });

  it("parses NETWORKS into an ordered list", () => {
    process.env.NETWORKS = "testnet,mainnet";
    expect(enabledNetworks()).toEqual(["testnet", "mainnet"]);
  });

  it("tolerates whitespace and case", () => {
    process.env.NETWORKS = " MAINNET , testnet ";
    expect(enabledNetworks()).toEqual(["mainnet", "testnet"]);
  });

  it("de-duplicates — two loops on one network would fight over the same cursor", () => {
    process.env.NETWORKS = "testnet,testnet";
    expect(enabledNetworks()).toEqual(["testnet"]);
  });

  it("drops unrecognised entries rather than starting a loop for them", () => {
    process.env.NETWORKS = "testnet,futurenet";
    expect(enabledNetworks()).toEqual(["testnet"]);
    expect(parseNetwork("futurenet")).toBeNull();
  });

  it("falls back to the configured network when NETWORKS is empty or all junk", () => {
    process.env.STELLAR_NETWORK = "mainnet";
    process.env.NETWORKS = "  ,  ";
    expect(enabledNetworks()).toEqual(["mainnet"]);

    process.env.NETWORKS = "nope,alsonope";
    expect(enabledNetworks()).toEqual(["mainnet"]);
  });
});

describe("per-network watch lists", () => {
  it("defaults each network to its own native XLM SAC", () => {
    // The bug this prevents: reading STELLAR_NETWORK inside the resolver, so
    // both loops watch the same chain's SAC and one indexes nothing.
    expect(resolveSacContractIds("testnet")).toEqual([DEFAULT_XLM_SAC_TESTNET]);
    expect(resolveSacContractIds("mainnet")).toEqual([DEFAULT_XLM_SAC_MAINNET]);
    expect(DEFAULT_XLM_SAC_TESTNET).not.toEqual(DEFAULT_XLM_SAC_MAINNET);
  });

  it("keeps the process-wide default when no network is passed", () => {
    process.env.STELLAR_NETWORK = "mainnet";
    expect(resolveSacContractIds()).toEqual([DEFAULT_XLM_SAC_MAINNET]);
  });

  it("prefers the per-network env var over the shared one", () => {
    process.env.SAC_CONTRACT_IDS = "CSHARED";
    process.env.SAC_CONTRACT_IDS_MAINNET = "CMAIN1,CMAIN2";

    expect(resolveSacContractIds("mainnet")).toEqual(["CMAIN1", "CMAIN2"]);
    // testnet has no override, so it still sees the shared value
    expect(resolveSacContractIds("testnet")).toEqual(["CSHARED"]);
  });

  it("still honours the legacy CONTRACT_IDS alias", () => {
    process.env.CONTRACT_IDS = "CLEGACY";
    expect(resolveSacContractIds("testnet")).toEqual(["CLEGACY"]);
  });

  it("resolves NFT watch lists per network", () => {
    process.env.NFT_CONTRACT_IDS = "CNFT_SHARED";
    process.env.NFT_CONTRACT_IDS_TESTNET = "CNFT_T";

    expect(resolveNftContractIds("testnet")).toEqual(["CNFT_T"]);
    expect(resolveNftContractIds("mainnet")).toEqual(["CNFT_SHARED"]);
  });

  it("treats an empty per-network var as unset, not as an empty watch list", () => {
    // .env.example declares SAC_CONTRACT_IDS_TESTNET= / NFT_CONTRACT_IDS_TESTNET=
    // as blank placeholders (#174). Anyone who copies it and fills in only the
    // shared var would otherwise get an empty list for every network.
    process.env.SAC_CONTRACT_IDS = "CSHARED";
    process.env.SAC_CONTRACT_IDS_TESTNET = "";
    process.env.NFT_CONTRACT_IDS = "CNFT_SHARED";
    process.env.NFT_CONTRACT_IDS_TESTNET = "";

    expect(resolveSacContractIds("testnet")).toEqual(["CSHARED"]);
    expect(resolveNftContractIds("testnet")).toEqual(["CNFT_SHARED"]);
  });
});

describe("per-network RPC clients (#160)", () => {
  it("returns one cached client per network, and never shares between them", () => {
    process.env.SOROBAN_RPC_URL_TESTNET = "https://testnet.example/rpc";
    process.env.SOROBAN_RPC_URL_MAINNET = "https://mainnet.example/rpc";

    const testnet = getRpc("testnet");
    const mainnet = getRpc("mainnet");

    // Same network → same instance (cached, so we don't open a pool per call)
    expect(getRpc("testnet")).toBe(testnet);
    // Different network → different instance. Sharing one was the whole bug.
    expect(mainnet).not.toBe(testnet);
  });

  it("scopes the legacy unsuffixed SOROBAN_RPC_URL to the configured network only", () => {
    // The dangerous case: a single-network deployment sets SOROBAN_RPC_URL for
    // testnet, then enables mainnet. If the legacy var applied to both, the
    // mainnet loop would connect to testnet RPC, index happily, and write
    // testnet ledgers tagged network='mainnet'. It must fail loudly instead.
    process.env.STELLAR_NETWORK = "testnet";
    process.env.SOROBAN_RPC_URL = "https://testnet.example/rpc";

    expect(() => getRpc("testnet")).not.toThrow();
    expect(() => getRpc("mainnet")).toThrow(/SOROBAN_RPC_URL_MAINNET is required/);
  });

  it("still lets a single-network mainnet deployment use the unsuffixed var", () => {
    process.env.STELLAR_NETWORK = "mainnet";
    process.env.SOROBAN_RPC_URL = "https://mainnet.example/rpc";

    expect(() => getRpc("mainnet")).not.toThrow();
  });

  it("defaults testnet to the public endpoint but refuses to guess for mainnet", () => {
    // There is no free public mainnet Soroban RPC, so guessing would produce a
    // client that fails on every call instead of a clear config error.
    expect(() => getRpc("testnet")).not.toThrow();
    expect(() => getRpc("mainnet")).toThrow(/no free public Soroban RPC|SOROBAN_RPC_URL_MAINNET/);
  });

  it("validateNetworkConfig checks every network it is given", () => {
    process.env.SOROBAN_RPC_URL_TESTNET = "https://testnet.example/rpc";

    expect(() => validateNetworkConfig(["testnet"])).not.toThrow();
    // Fails at startup rather than after testnet has begun writing.
    expect(() => validateNetworkConfig(["testnet", "mainnet"])).toThrow();
  });
});

describe("loop state isolation", () => {
  it("reports no running loops before any are started", () => {
    expect(runningNetworks()).toEqual([]);
  });

  it("reports zero indexed for a network with no loop, rather than another network's total", () => {
    // Guards the shape of the failure: an un-started loop must not inherit
    // whatever the other loop has counted.
    expect(getIndexerStats("mainnet").totalIndexed).toBe(0);
    expect(getIndexerStats("testnet").totalIndexed).toBe(0);
  });

  it("getIndexerStats keeps its original shape for existing /status consumers", () => {
    const stats = getIndexerStats();
    expect(stats).toEqual({
      startedAt: expect.any(String),
      uptimeSeconds: expect.any(Number),
      totalIndexed: expect.any(Number),
    });
    expect(new Date(stats.startedAt).toString()).not.toBe("Invalid Date");
  });

  it("resolves the default network from the environment on every call", () => {
    process.env.STELLAR_NETWORK = "mainnet";
    expect(currentNetwork()).toBe("mainnet");
    process.env.STELLAR_NETWORK = "testnet";
    expect(currentNetwork()).toBe("testnet");
  });
});
