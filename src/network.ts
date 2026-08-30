/**
 * The network dimension.
 *
 * Wraith stores testnet and mainnet rows in the same tables, discriminated by
 * a `network` column (#159). This module is the single place that decides what
 * "the current network" means, so the answer cannot drift between the indexer,
 * the API and the jobs.
 *
 * Every db.ts function takes an optional `network` argument that defaults to
 * {@link currentNetwork}. That keeps today's single-network callers working
 * untouched while giving the per-network indexer loop (#161) and the API
 * network selector (#163) somewhere explicit to pass.
 */

export type Network = "testnet" | "mainnet";

export const NETWORKS: readonly Network[] = ["testnet", "mainnet"] as const;

/** The value back-filled onto every pre-existing row by the #159 migration. */
export const DEFAULT_NETWORK: Network = "testnet";

export function isNetwork(value: unknown): value is Network {
  return value === "testnet" || value === "mainnet";
}

/**
 * Coerce arbitrary input (env var, query string, header) to a Network.
 * Returns null rather than throwing so callers can decide between a 400 and a
 * fallback — an indexer wants to fail loudly, an HTTP route wants to answer.
 */
export function parseNetwork(value: unknown): Network | null {
  if (typeof value !== "string") return null;
  const normalised = value.trim().toLowerCase();
  return isNetwork(normalised) ? normalised : null;
}

/**
 * The network this process is configured for, from `STELLAR_NETWORK`.
 *
 * Read from the environment on every call rather than cached at import time:
 * caching would freeze whatever the environment happened to be when the first
 * module imported this one, which makes the value untestable and surprising in
 * workers that set their environment after startup.
 *
 * Falls back to testnet — the same default the column carries — so an unset
 * variable behaves exactly like the pre-#159 code did.
 */
export function currentNetwork(): Network {
  return parseNetwork(process.env.STELLAR_NETWORK) ?? DEFAULT_NETWORK;
}

/** Resolve an optional explicit network against the configured default. */
export function resolveNetwork(network?: Network): Network {
  return network ?? currentNetwork();
}

/**
 * The networks this process should index, from `NETWORKS` (comma-separated).
 *
 * Defaults to just {@link currentNetwork}, so a deployment that sets only
 * `STELLAR_NETWORK` keeps running exactly one loop — the pre-#161 behaviour.
 * `NETWORKS=testnet,mainnet` opts into indexing both in one process.
 *
 * Unrecognised entries are dropped rather than throwing: a typo should not
 * take the whole indexer down, and the caller logs what it actually started.
 * An empty or entirely invalid list falls back to the configured network for
 * the same reason.
 */
export function enabledNetworks(): Network[] {
  const raw = process.env.NETWORKS ?? "";
  const parsed = raw
    .split(",")
    .map((entry) => parseNetwork(entry))
    .filter((entry): entry is Network => entry !== null);

  // De-duplicate: NETWORKS=testnet,testnet must not start two loops writing
  // the same rows and fighting over the same cursor.
  const unique = [...new Set(parsed)];
  return unique.length > 0 ? unique : [currentNetwork()];
}
