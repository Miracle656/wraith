import { rpc as RPC, xdr, scValToNative, Contract, TransactionBuilder, Account, Networks } from "@stellar/stellar-sdk";
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

/**
 * One page of contract events plus the paging state needed to continue.
 *
 * `latestLedger` is the network tip and says nothing about which ledgers the
 * returned events cover — a page can come back full and truncated. `cursor`
 * is how that truncated page is resumed, and `maxLedger` is the highest
 * `event.ledger` actually seen in this page.
 */
export interface FetchEventsPage {
  events: RawEvent[];
  /** Network tip the RPC reported alongside this page. */
  latestLedger: number;
  /** Opaque paging cursor for continuing after a full page. */
  cursor: string | undefined;
  /** Highest `event.ledger` in this page; 0 when it returned no events. */
  maxLedger: number;
}

/** Options for {@link fetchEvents}. */
export interface FetchEventsOptions {
  /** Continue from a previous page's cursor instead of `startLedger`. */
  cursor?: string;
}

// ─── getEvents wrapper ────────────────────────────────────────────────────────
/**
 * Fetch one page of contract events from Stellar RPC.
 *
 * @param startLedger  First ledger to include (inclusive).
 * @param contractIds  Filter to specific contract IDs. Pass [] to skip filter.
 * @param limit        Max events per call (RPC hard-caps at 10 000).
 * @param network      Which chain to read. Defaults to the configured network.
 * @param options      Continue from a cursor to read the next page.
 */
export async function fetchEvents(
  startLedger: number,
  contractIds: string[],
  limit: number = 10_000,
  network?: Network,
  options?: FetchEventsOptions
): Promise<FetchEventsPage> {
  const rpc = getRpc(network);

  // Api.EventFilter allows: type, contractIds (string[]), topics (string[][]).
  // `as const` keeps `type` a literal: extracting the array from its old
  // inline position would otherwise widen it to `string`.
  const filters = [
    {
      type: "contract" as const,
      // Only pass contractIds if the caller is watching specific contracts;
      // omitting the field lets RPC return events for all contracts.
      ...(contractIds.length > 0 ? { contractIds } : {}),
    },
  ];

  // Api.GetEventsRequest is a union of two mutually exclusive shapes: a range
  // request starts at a ledger, a paging request continues from a cursor.
  const cursor = options?.cursor;
  const request: RPC.Server.GetEventsRequest = cursor
    ? { cursor, limit, filters }
    : { startLedger, limit, filters };

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

  const maxLedger = events.reduce((max, e) => Math.max(max, e.ledger), 0);

  return { events, latestLedger: resp.latestLedger, cursor: resp.cursor, maxLedger };
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
 * Returns all events that could be decoded, plus the highest ledger *fully
 * covered* by them — never the raw network tip.
 */
type FetchFn = typeof fetchEvents

/**
 * Hard cap on how many getEvents round-trips one range may issue. A range
 * holding more events than `limit` is drained a page at a time; this bound
 * stops a pathological stream of full pages from making unbounded RPC calls in
 * a single poll. When it is hit the range is treated as truncated and the
 * caller only advances to the highest ledger it actually observed.
 */
export const EVENTS_PAGE_BUDGET = 20;

/**
 * Drain `[startLedger, endLedger]` by following the RPC cursor while pages come
 * back full, up to {@link EVENTS_PAGE_BUDGET} pages.
 *
 * Events above `endLedger` are dropped rather than returned: cursor paging has
 * no upper bound of its own, and ingesting past the caller's window would read
 * the un-settled ledgers `TIP_LAG` exists to avoid.
 */
async function fetchRangePaged(
  startLedger: number,
  endLedger: number,
  contractIds: string[],
  limit: number,
  _fetchFn: FetchFn,
  network?: Network,
): Promise<{ events: RawEvent[]; latestLedger: number; maxLedger: number; truncated: boolean }> {
  const events: RawEvent[] = [];
  let latestLedger = startLedger;
  let maxLedger = 0;
  let cursor: string | undefined;
  let truncated = false;

  for (let page = 0; page < EVENTS_PAGE_BUDGET; page++) {
    // The first page addresses the range by startLedger; every later page
    // continues from the cursor a full page handed back.
    const res = cursor === undefined
      ? await _fetchFn(startLedger, contractIds, limit, network)
      : await _fetchFn(startLedger, contractIds, limit, network, { cursor });

    latestLedger = res.latestLedger;
    for (const event of res.events) {
      if (event.ledger > maxLedger) maxLedger = event.ledger;
      if (event.ledger <= endLedger) events.push(event);
    }
    // fetchEvents reports its own page maximum; fold it in so the bound holds
    // even if a fetchFn returns a page whose `events` list was filtered.
    if (typeof res.maxLedger === "number" && res.maxLedger > maxLedger) {
      maxLedger = res.maxLedger;
    }

    const fullPage = res.events.length >= limit;
    // A short page means the RPC had nothing more to return; a page that
    // reached endLedger means the requested window is covered.
    if (!fullPage || maxLedger >= endLedger) break;

    const next = res.cursor;
    if (!next) {
      truncated = true;
      break;
    }
    if (page === EVENTS_PAGE_BUDGET - 1) {
      truncated = true;
      break;
    }
    cursor = next;
  }

  return { events, latestLedger, maxLedger, truncated };
}

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
    const { events, latestLedger, maxLedger, truncated } = await fetchRangePaged(
      startLedger,
      endLedger,
      contractIds,
      limit,
      _fetchFn,
      network,
    );
    // The cursor may only advance to the highest ledger the drained pages
    // actually covered, and never past endLedger. When the page budget cut the
    // range short we have not fully covered `latestLedger`, so fall back to
    // the highest event we actually saw.
    const lastFullyCovered = truncated ? maxLedger : latestLedger;
    return { events, highestLedger: Math.min(lastFullyCovered, endLedger) };
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

// ─── Token Metadata ──────────────────────────────────────────────────────────
/**
 * Fetch token metadata (symbol, decimals, name) from a Soroban token contract.
 * Uses simulateTransaction to call the read-only getter methods.
 */
export async function fetchTokenMetadata(
  contractId: string,
  network?: Network,
): Promise<{
  symbol: string;
  decimals: number;
  name: string;
}> {
  // Both the RPC endpoint and the passphrase must come from the network being
  // asked about, not from STELLAR_NETWORK. With a loop per network (#161),
  // reading the process default here would simulate a mainnet contract call
  // against testnet — returning either nothing or a different token entirely.
  const net = resolveNetwork(network);
  const rpc = getRpc(net);
  const contract = new Contract(contractId);
  const networkPassphrase = net === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

  // Helper to call a zero-arg method and decode the result
  const callMethod = async (method: string): Promise<any> => {
    // Build a dummy transaction for simulation. Source account and sequence 
    // don't matter for read-only simulation.
    const tx = new TransactionBuilder(
      new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"),
      { fee: "100", networkPassphrase }
    )
      .addOperation(contract.call(method))
      .setTimeout(0)
      .build();

    const resp = await rpc.simulateTransaction(tx);
    if (RPC.Api.isSimulationSuccess(resp)) {
      const scVal = resp.result!.retval;
      return scValToNative(scVal);
    }
    throw new Error(`RPC simulation failed for ${method}: ${JSON.stringify(resp)}`);
  };

  const [symbol, decimals, name] = await Promise.all([
    callMethod("symbol"),
    callMethod("decimals"),
    callMethod("name"),
  ]);

  return {
    symbol: String(symbol),
    decimals: Number(decimals),
    name: String(name),
  };
}
