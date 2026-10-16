import { readFileSync, readdirSync } from "fs";
import path from "path";
import { validateEnv } from "../validateEnv";

const sourceRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(sourceRoot, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(fullPath);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [fullPath]
      : [];
  });
}

function environmentReads(): Set<string> {
  const names = new Set<string>();
  const staticRead = /\b(?:process\.)?env\.([A-Z][A-Z0-9_]*)|\bprocess\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;
  const dynamicNetworkRead = /\bprocess\.env\[\s*`([A-Z][A-Z0-9_]*)\$\{/g;
  const namedRead = /readPositiveInt\(\s*["']([A-Z][A-Z0-9_]*)["']/g;

  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(staticRead)) {
      names.add(match[1] ?? match[2]);
    }
    for (const match of source.matchAll(dynamicNetworkRead)) {
      names.add(`${match[1]}TESTNET`);
      names.add(`${match[1]}MAINNET`);
    }
    for (const match of source.matchAll(namedRead)) {
      names.add(match[1]);
    }
  }

  return names;
}

describe("environment configuration", () => {
  it("documents every environment variable read by runtime source", () => {
    const example = readFileSync(path.join(repositoryRoot, ".env.example"), "utf8");
    const documented = new Set(
      [...example.matchAll(/^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(
        (match) => match[1],
      ),
    );
    const undocumented = [...environmentReads()].filter((name) => !documented.has(name)).sort();

    expect(undocumented).toEqual([]);
  });

  it("reports all missing required variables together", () => {
    expect(() => validateEnv({ STELLAR_NETWORK: "mainnet" })).toThrow(
      "Missing required env vars: DATABASE_URL, DIRECT_DATABASE_URL, SOROBAN_RPC_URL_MAINNET",
    );
  });

  it("accepts the legacy RPC URL for a single-network mainnet deployment", () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: "postgresql://localhost/wraith",
        DIRECT_DATABASE_URL: "postgresql://localhost/wraith",
        STELLAR_NETWORK: "mainnet",
        SOROBAN_RPC_URL: "https://rpc.example.invalid",
      }),
    ).not.toThrow();
  });

  it("requires a network-specific RPC URL when indexing multiple networks", () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: "postgresql://localhost/wraith",
        DIRECT_DATABASE_URL: "postgresql://localhost/wraith",
        STELLAR_NETWORK: "testnet",
        NETWORKS: "testnet,mainnet",
        SOROBAN_RPC_URL: "https://rpc.example.invalid",
      }),
    ).toThrow(/SOROBAN_RPC_URL_MAINNET/);
  });

  it("does not require RPC when the indexer is disabled", () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: "postgresql://localhost/wraith",
        DIRECT_DATABASE_URL: "postgresql://localhost/wraith",
        STELLAR_NETWORK: "mainnet",
        SKIP_INDEXER: "true",
      }),
    ).not.toThrow();
  });
});