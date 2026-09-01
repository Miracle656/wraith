import { prisma } from "./db";
import { fetchTokenMetadata } from "./rpc";
import { resolveNetwork, type Network } from "./network";

export interface TokenMetadata {
  network: Network;
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
}

/**
 * In-memory cache, keyed by `network:contractId`.
 *
 * The network has to be part of the key. A contract id is only unique within a
 * chain, so a testnet token deployed at the same address as a mainnet one would
 * otherwise serve the wrong symbol and — worse — the wrong `decimals`, which
 * silently rescales every amount rendered from it.
 */
const cache = new Map<string, TokenMetadata>();

function cacheKey(network: Network, contractId: string): string {
  return `${network}:${contractId}`;
}

/**
 * Populate the in-memory cache from the database on startup.
 *
 * Loads only the given network's rows: a loop indexing one chain has no use for
 * the other's tokens, and keeping them apart is the point of the composite key.
 */
export async function initTokenCache(network?: Network): Promise<void> {
  const net = resolveNetwork(network);
  try {
    const tokens = await prisma.tokenMetadata.findMany({ where: { network: net } });
    for (const token of tokens) {
      cache.set(cacheKey(net, token.contractId), token as TokenMetadata);
    }
    console.log(`[cache/${net}] Initialized with ${tokens.length} tokens from DB`);
  } catch (err) {
    console.error(
      `[cache/${net}] Failed to initialize token cache from DB:`,
      (err as Error).message,
    );
    // Continue anyway; it will fill from RPC as needed.
  }
}

/**
 * Get token metadata for a contract on a network.
 * Checks memory → then the database → then Soroban RPC.
 */
export async function getTokenMetadata(
  contractId: string,
  network?: Network,
): Promise<TokenMetadata> {
  const net = resolveNetwork(network);
  const key = cacheKey(net, contractId);

  // 1. In-memory cache.
  const cached = cache.get(key);
  if (cached) return cached;

  // 2. Database — another process, or an earlier run, may already have it.
  const dbToken = await prisma.tokenMetadata.findUnique({
    where: { network_contractId: { network: net, contractId } },
  });
  if (dbToken) {
    cache.set(key, dbToken as TokenMetadata);
    return dbToken as TokenMetadata;
  }

  // 3. Soroban RPC. Asked of this network's endpoint rather than the process
  // default: querying the wrong chain returns either nothing or another token.
  console.log(`[cache/${net}] Cache miss for ${contractId} — fetching from RPC…`);
  const metadata = await fetchTokenMetadata(contractId, net);
  const token: TokenMetadata = { network: net, contractId, ...metadata };

  // 4. Persist to the database and memory.
  await prisma.tokenMetadata.upsert({
    where: { network_contractId: { network: net, contractId } },
    create: token,
    update: token,
  });

  cache.set(key, token);
  return token;
}

/**
 * Return all tokens currently held in the in-memory cache, optionally narrowed
 * to one network.
 */
export function getAllCachedTokens(network?: Network): TokenMetadata[] {
  const all = Array.from(cache.values());
  return network ? all.filter((t) => t.network === network) : all;
}

/** Test-only: drop the in-memory cache. */
export function _resetTokenCache(): void {
  cache.clear();
}
