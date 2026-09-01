import { rpc as RPC, xdr } from "@stellar/stellar-sdk";
import { resolveNetwork, currentNetwork, type Network } from "./network";
import { recordRpcError } from "./metrics";

// ─── Network config ───────────────────────────────────────────────────────────
const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";

/**
 * Resolve the Soroban RPC endpoint for one network.
 *
 * Resolution order, per network:
 *   1. SOROBAN_RPC_URL_TESTNET / SOROBAN_RPC_URL_MAINNET (explicit, per network)
 *   2. SOROBAN_RPC_URL / STELLAR_RPC_URL — but **only for the network this
 *      process is configured as** (STELLAR_NETWORK). See below.
 *   3. testnet → default public testnet endpoint
 *   4. mainnet → throws; there is no free public mainnet Soroban RPC
 *
 * Step 2 is deliberately narrow. The unsuffixed variables predate multi-network
 * support, so a deployment that sets `SOROBAN_RPC_URL` means "the endpoint for
 * the network I run". Honouring it for *both* networks would silently point a
 * mainnet indexer at a testnet endpoint — it would connect, index happily, and
 * write testnet ledger data tagged `network='mainnet'`. Scoping the legacy
 * variable to the configured network keeps every single-network deployment
 * behaving exactly as before while making that mix-up impossible.
 */
function resolveRpcUrl(network: Network): string {
  const suffix = network.toUpperCase();
  const perNetwork =
    process.env[`SOROBAN_RPC_URL_${suffix}`] || process.env[`STELLAR_RPC_URL_${suffix}`];
  if (perNetwork) return perNetwork;

  if (network === currentNetwork()) {
    const legacy = process.env.SOROBAN_RPC_URL || process.env.STELLAR_RPC_URL;
    if (legacy) return legacy;
  }

  if (network === "testnet") return TESTNET_RPC_URL;

  throw new Error(
    `[wraith] SOROBAN_RPC_URL_MAINNET is required to index mainnet. ` +
    "There is no free public Soroban RPC for mainnet — set it to your " +
    "provider's endpoint (e.g. Validation Cloud, Ankr, self-hosted). " +
    "Single-network deployments may still use SOROBAN_RPC_URL with " +
    "STELLAR_NETWORK=mainnet."
  );
}

/**
 * Validate RPC configuration at startup for every network given (defaults to
 * the configured one). Call before opening DB connections so a misconfigured
 * endpoint surfaces immediately rather than on the first poll.
 */
export function validateNetworkConfig(networks: Network[] = [currentNetwork()]): void {
  for (const network of networks) {
    resolveRpcUrl(network); // throws with a human-readable message
  }
}

// ─── RPC clients, one per network ─────────────────────────────────────────────
// Cached per network: repeated calls reuse a connection, and two networks can
// never share one — which was impossible with the previous single singleton.
const clients = new Map<Network, RPC.Server>();

export function getRpc(network?: Network): RPC.Server {
  const net = resolveNetwork(network);
  let client = clients.get(net);
  if (!client) {
    const url = resolveRpcUrl(net);
    client = new RPC.Server(url, { allowHttp: url.startsWith("http://") });
    clients.set(net, client);
  }
  return client;
}

/** Test-only: drops cached clients so a test can rebind env or mocks. */
export function _resetRpcClients(): void {
  clients.clear();
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
 * @param network      Which chain to read. Defaults to the configured network.
 */
export async function fetchEvents(
  startLedger: number,
  contractIds: string[],
  limit: number = 10_000,
  network?: Network
): Promise<{ events: RawEvent[]; latestLedger: number }> {
  const rpc = getRpc(network);

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
export async function getLatestLedger(network?: Network): Promise<number> {
  const rpc = getRpc(network);
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
      if (attempt >= maxAttempts) {
        recordRpcError("exhausted");
        throw err;
      }
      recordRpcError("retry");
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
  _fetchFn: FetchFn = fetchEvents,
  network?: Network
): Promise<{ events: RawEvent[]; highestLedger: number }> {
  // If the range is a single ledger and it fails, skip it.
  if (startLedger >= endLedger) {
    try {
      const { events, latestLedger } = await _fetchFn(startLedger, contractIds, limit, network);
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
    const { events, latestLedger } = await _fetchFn(startLedger, contractIds, limit, network);
    return { events, highestLedger: latestLedger };
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (!msg.includes("XDR") && !msg.includes("unknown")) throw err;

    // Bisect: try lower half, then upper half
    console.warn(`[rpc] XDR error in ledgers ${startLedger}–${endLedger}, bisecting…`);
    const mid = Math.floor((startLedger + endLedger) / 2);

    const lower = await fetchEventsSafe(startLedger, mid, contractIds, limit, _fetchFn, network);
    const upper = await fetchEventsSafe(mid + 1, endLedger, contractIds, limit, _fetchFn, network);

    return {
      events: [...lower.events, ...upper.events],
      highestLedger: Math.max(lower.highestLedger, upper.highestLedger),
    };
  }
}
