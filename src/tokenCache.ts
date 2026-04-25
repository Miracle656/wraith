import { prisma } from "./db";
import { fetchTokenMetadata } from "./rpc";

export interface TokenMetadata {
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
}

// In-memory cache for fast lookups
const cache = new Map<string, TokenMetadata>();

/**
 * Populate the in-memory cache from the database on startup.
 */
export async function initTokenCache(): Promise<void> {
  try {
    const tokens = await prisma.tokenMetadata.findMany();
    for (const token of tokens) {
      cache.set(token.contractId, token);
    }
    console.log(`[cache] Initialized with ${tokens.length} tokens from DB`);
  } catch (err) {
    console.error("[cache] Failed to initialize token cache from DB:", (err as Error).message);
    // Continue anyway; it will fill from RPC as needed
  }
}

/**
 * Get token metadata by contractId.
 * Checks Memory -> then DB -> then RPC.
 */
export async function getTokenMetadata(contractId: string): Promise<TokenMetadata> {
  // 1. Check in-memory cache
  const cached = cache.get(contractId);
  if (cached) return cached;

  // 2. Check database (in case it was added by another process/instance)
  const dbToken = await prisma.tokenMetadata.findUnique({ where: { contractId } });
  if (dbToken) {
    cache.set(contractId, dbToken);
    return dbToken;
  }

  // 3. Fetch from Soroban RPC
  console.log(`[cache] Cache miss for ${contractId} — fetching from RPC…`);
  const metadata = await fetchTokenMetadata(contractId);
  const token: TokenMetadata = { contractId, ...metadata };

  // 4. Persist to DB and memory
  await prisma.tokenMetadata.upsert({
    where: { contractId },
    create: token,
    update: token,
  });

  cache.set(contractId, token);
  return token;
}

/**
 * Return all tokens currently held in the in-memory cache.
 */
export function getAllCachedTokens(): TokenMetadata[] {
  return Array.from(cache.values());
}
