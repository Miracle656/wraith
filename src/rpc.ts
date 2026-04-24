import { rpc as RPC, xdr } from "@stellar/stellar-sdk";

// ─── Network config ───────────────────────────────────────────────────────────
const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";

/**
 * Resolve the Soroban RPC endpoint from environment variables.
 *
 * Resolution order:
 *   1. SOROBAN_RPC_URL  (explicit — takes precedence)
 *   2. STELLAR_RPC_URL  (backward-compat alias)
 *   3. STELLAR_NETWORK=testnet  → default testnet URL
 *   4. STELLAR_NETWORK=mainnet  → requires explicit SOROBAN_RPC_URL; no free
 *                                  public mainnet RPC exists, so we fail fast
 *   5. Nothing set → throws with a clear configuration guide
 */
function resolveRpcUrl(): string {
  const explicit = process.env.SOROBAN_RPC_URL ?? process.env.STELLAR_RPC_URL;
  if (explicit) return explicit;

  const network = (process.env.STELLAR_NETWORK ?? "").toLowerCase();

  if (network === "testnet") return TESTNET_RPC_URL;

  if (network === "mainnet") {
    throw new Error(
      "[wraith] SOROBAN_RPC_URL is required when STELLAR_NETWORK=mainnet. " +
      "There is no free public Soroban RPC for mainnet — set SOROBAN_RPC_URL " +
      "to your provider's endpoint (e.g. Validation Cloud, Ankr, self-hosted)."
    );
  }

  throw new Error(
    "[wraith] RPC endpoint not configured. " +
    "Set SOROBAN_RPC_URL to your Soroban RPC endpoint, or set STELLAR_NETWORK=testnet " +
    "to use the default public testnet endpoint automatically."
  );
}

/**
 * Validate the network configuration at startup.
 * Call this before opening DB connections so configuration errors surface
 * immediately instead of on the first RPC call.
 */
export function validateNetworkConfig(): void {
  resolveRpcUrl(); // throws with a human-readable message if misconfigured
}

// ─── RPC client singleton ─────────────────────────────────────────────────────
let _rpc: RPC.Server | null = null;

export function getRpc(): RPC.Server {
  if (!_rpc) {
    const url = resolveRpcUrl();
    _rpc = new RPC.Server(url, { allowHttp: url.startsWith("http://") });
  }
  return _rpc;
}

// ─── Types ────────────────────────────────────────────────────────────────────
/**
 * Normalised event shape we carry through the pipeline.
 * contractId is always a plain string (C...) — we unwrap the Contract object here.
 */
export interface RawEvent {
  id: string;             // paging token / eventId
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;     // always a plain C... string
  txHash: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
}

// ─── getEvents wrapper ────────────────────────────────────────────────────────
/**
 * Fetch contract events from Stellar RPC.
 *
 * @param startLedger  First ledger to include (inclusive).
 * @param contractIds  Filter to specific contract IDs. Pass [] to skip filter.
 * @param limit        Max events per call (RPC hard-caps at 10 000).
 */
export async function fetchEvents(
  startLedger: number,
  contractIds: string[],
  limit: number = 10_000
): Promise<{ events: RawEvent[]; latestLedger: number }> {
  const rpc = getRpc();

  // Build the request using the correct Server.GetEventsRequest type.
  // Api.EventFilter allows: type, contractIds (string[]), topics (string[][]).
  const request: RPC.Server.GetEventsRequest = {
    startLedger,
    limit,
    filters: [
      {
        type: "contract",
        // Only pass contractIds if the caller is watching specific contracts;
        // omitting the field lets RPC return events for all contracts.
        ...(contractIds.length > 0 ? { contractIds } : {}),
      },
    ],
  };

  const resp = await rpc.getEvents(request);

  // Api.EventResponse.contractId is Contract | undefined.
  // Contract.contractId() returns the C... strkey string.
  const events: RawEvent[] = (resp.events ?? []).map((e) => ({
    id: e.id,
    type: e.type,
    ledger: e.ledger,
    ledgerClosedAt: e.ledgerClosedAt,
    // Unwrap Contract object → plain string address
    contractId: e.contractId?.contractId() ?? "",
    txHash: e.txHash,
    topic: e.topic,
    value: e.value,
  }));

  return { events, latestLedger: resp.latestLedger };
}

// ─── Network tip helper ───────────────────────────────────────────────────────
export async function getLatestLedger(): Promise<number> {
  const rpc = getRpc();
  const resp = await rpc.getLatestLedger();
  return resp.sequence;
}

// ─── Exponential back-off retry ───────────────────────────────────────────────
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 5,
  baseDelayMs = 1_000
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `[rpc] Attempt ${attempt} failed — retrying in ${delay}ms…`,
        (err as Error).message
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── XDR-safe event fetch ─────────────────────────────────────────────────────
/**
 * Like fetchEvents but handles XDR decode errors gracefully.
 *
 * Some ledgers contain events that use newer XDR types than the SDK knows
 * (e.g. ScAddressType value 3 added in a recent protocol upgrade). When a
 * batch fails with an XDR error, we bisect the ledger range to skip only the
 * single problematic ledger and continue indexing the rest.
 *
 * Returns all events that could be decoded, plus the highest ledger reached.
 */
type FetchFn = typeof fetchEvents

export async function fetchEventsSafe(
  startLedger: number,
  endLedger: number,
  contractIds: string[],
  limit: number = 10_000,
  _fetchFn: FetchFn = fetchEvents
): Promise<{ events: RawEvent[]; highestLedger: number }> {
  // If the range is a single ledger and it fails, skip it.
  if (startLedger >= endLedger) {
    try {
      const { events, latestLedger } = await _fetchFn(startLedger, contractIds, limit);
      return { events, highestLedger: Math.max(startLedger, latestLedger) };
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("XDR") || msg.includes("unknown")) {
        console.warn(`[rpc] Skipping ledger ${startLedger} — XDR decode error: ${msg}`);
        return { events: [], highestLedger: startLedger };
      }
      throw err;
    }
  }

  try {
    const { events, latestLedger } = await _fetchFn(startLedger, contractIds, limit);
    return { events, highestLedger: latestLedger };
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (!msg.includes("XDR") && !msg.includes("unknown")) throw err;

    // Bisect: try lower half, then upper half
    console.warn(`[rpc] XDR error in ledgers ${startLedger}–${endLedger}, bisecting…`);
    const mid = Math.floor((startLedger + endLedger) / 2);

    const lower = await fetchEventsSafe(startLedger, mid, contractIds, limit, _fetchFn);
    const upper = await fetchEventsSafe(mid + 1, endLedger, contractIds, limit, _fetchFn);

    return {
      events: [...lower.events, ...upper.events],
      highestLedger: Math.max(lower.highestLedger, upper.highestLedger),
    };
  }
}
