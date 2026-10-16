/** Validate startup configuration before the service opens its listeners. */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const missing = ["DATABASE_URL", "DIRECT_DATABASE_URL"].filter(
    (name) => !env[name]?.trim(),
  );

  const configuredNetwork = env.STELLAR_NETWORK?.trim().toLowerCase();
  const defaultNetwork = configuredNetwork === "mainnet" ? "mainnet" : "testnet";
  const networks = (env.NETWORKS ?? "")
    .split(",")
    .map((network) => network.trim().toLowerCase())
    .filter((network): network is "testnet" | "mainnet" =>
      network === "testnet" || network === "mainnet",
    );
  const enabledNetworks = networks.length > 0 ? [...new Set(networks)] : [defaultNetwork];

  if (env.SKIP_INDEXER !== "true" && enabledNetworks.includes("mainnet")) {
    const hasMainnetRpc =
      env.SOROBAN_RPC_URL_MAINNET?.trim() ||
      env.STELLAR_RPC_URL_MAINNET?.trim() ||
      (defaultNetwork === "mainnet" &&
        (env.SOROBAN_RPC_URL?.trim() || env.STELLAR_RPC_URL?.trim()));

    if (!hasMainnetRpc) {
      missing.push(
        "SOROBAN_RPC_URL_MAINNET (or STELLAR_RPC_URL_MAINNET; single-network deployments may use SOROBAN_RPC_URL or STELLAR_RPC_URL)",
      );
    }
  }

  if (missing.length > 0) {
    throw new Error(`[wraith] Missing required env vars: ${missing.join(", ")}`);
  }
}