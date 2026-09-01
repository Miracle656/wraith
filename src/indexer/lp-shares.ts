/**
 * LP-share transfer indexer (liquidity-pool deposits & withdrawals).
 *
 * When a liquidity provider deposits into a Soroban AMM pool the pool *mints*
 * LP-share tokens to them; when they withdraw the pool *burns* those shares.
 * The shares are a real token, but they are non-trivially named — an LP position
 * in pool `C…` is just "shares of C…", with no symbol of its own — so plain
 * SEP-41 indexing buries them. This module surfaces them as first-class
 * LP-share transfers, each tagged with the pool whose shares moved.
 *
 * The pool *is* the contract that emits the event, so the pool ID is always the
 * event's `contractId`. We normalise both event dialects seen in the wild:
 *
 *   Explicit deposit/withdraw (Soroswap, Phoenix, …):
 *     topics[0] = Symbol("deposit" | "withdraw")
 *     topics[1] = Address(provider)             ← the LP
 *     value     = i128(shares)  | Map{ shares / amount: i128, … }
 *
 *   Bare SEP-41 mint/burn of the pool's own share token (native liquidity_pool
 *   SAC and pools that emit the token event directly):
 *     mint: topics[0]=Symbol("mint"), topics[2]=Address(to),   value=i128(shares)
 *     burn: topics[0]=Symbol("burn"), topics[1]=Address(from), value=i128(shares)
 *
 * Deposits are modelled as a transfer *to* the provider (shares minted, no
 * sender); withdrawals as a transfer *from* the provider (shares burned, no
 * recipient) — mirroring how `decoder.ts` treats mint/burn.
 *
 * Decoding is pure and never throws; a malformed or unrecognised event yields
 * null so a single bad event can never stall ingest.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { prisma } from "../db";
import type { RawEvent } from "../rpc";
import { resolveNetwork, type Network } from "../network";

const { xdr, Address, scValToNative } = StellarSdk;

// ─── Recognised event types ─────────────────────────────────────────────────
// Two dialects, and they are NOT equally safe to accept.
//
// "deposit"/"withdraw" are pool-specific: a contract emitting them is telling
// you it is a pool, so they can be accepted from any contract.
//
// "mint"/"burn" are generic SEP-41 — every stablecoin issuer, every ordinary
// SAC, every token in existence emits them. Accepting those unconditionally
// would write every USDC mint into LpShareTransfer with poolId = the USDC
// contract, double-storing it beside its own token-transfer row and defeating
// the point of a table meant to surface liquidity-pool shares. So the bare
// dialect is only honoured from a contract already known to be a pool.
const EXPLICIT_DEPOSIT_EVENTS = new Set(["deposit"]);
const EXPLICIT_WITHDRAW_EVENTS = new Set(["withdraw"]);
const BARE_DEPOSIT_EVENTS = new Set(["mint"]);
const BARE_WITHDRAW_EVENTS = new Set(["burn"]);

const DEPOSIT_EVENTS = new Set([...EXPLICIT_DEPOSIT_EVENTS, ...BARE_DEPOSIT_EVENTS]);
const WITHDRAW_EVENTS = new Set([...EXPLICIT_WITHDRAW_EVENTS, ...BARE_WITHDRAW_EVENTS]);

/** True for the pool-specific dialect, which self-identifies as a pool event. */
export function isExplicitPoolSymbol(sym: string): boolean {
  return EXPLICIT_DEPOSIT_EVENTS.has(sym) || EXPLICIT_WITHDRAW_EVENTS.has(sym);
}

/** True for the generic SEP-41 dialect, which every token emits. */
function isBareTokenSymbol(sym: string): boolean {
  return BARE_DEPOSIT_EVENTS.has(sym) || BARE_WITHDRAW_EVENTS.has(sym);
}

/**
 * Pools named explicitly in the environment, so a deployment can index a pool
 * that only ever emits bare mint/burn without waiting to observe a deposit.
 * Per-network suffix first, then the shared name.
 */
export function resolveLpPoolIds(network?: Network): string[] {
  const suffix = resolveNetwork(network).toUpperCase();
  const raw =
    process.env[`LP_POOL_CONTRACT_IDS_${suffix}`] ||
    process.env.LP_POOL_CONTRACT_IDS ||
    "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Every contract already recorded as a pool on this network, used to seed the
 * known-pool set when a loop starts. Without this, a restart would forget which
 * contracts are pools and silently stop recording their bare mint/burn events
 * until the next explicit deposit came through.
 */
export async function loadKnownLpPools(network?: Network): Promise<string[]> {
  const net = resolveNetwork(network);
  const rows = await prisma.lpShareTransfer.findMany({
    where: { network: net },
    select: { poolId: true },
    distinct: ["poolId"],
  });
  return rows.map((r) => r.poolId);
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Direction of an LP-share movement relative to the provider. */
export type LpAction = "deposit" | "withdraw";

/**
 * A normalised LP-share transfer. `poolId` is the pool contract whose shares
 * moved (always the emitting contract). For a deposit the shares are minted to
 * `toAddress` (no `fromAddress`); for a withdrawal they are burned from
 * `fromAddress` (no `toAddress`).
 */
export interface LpShareTransferRecord {
  poolId: string;
  action: LpAction;
  fromAddress: string | null;
  toAddress: string | null;
  shares: string; // i128 share amount as a decimal string
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  eventId: string;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Decode topic[0] to its symbol string, lower-cased, or null if not a symbol. */
function eventSymbol(raw: RawEvent): string | null {
  if (!raw.topic || raw.topic.length === 0) return null;
  try {
    const native = scValToNative(raw.topic[0]);
    return typeof native === "string" ? native.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Decode an Address ScVal to a G…/C… string, or null if it is not an address. */
function decodeAddress(scVal: StellarSdk.xdr.ScVal): string | null {
  try {
    if (scVal.switch() !== xdr.ScValType.scvAddress()) return null;
    return Address.fromScVal(scVal).toString();
  } catch {
    return null;
  }
}

/**
 * Pull the share amount out of an event value. Pools emit it either as a bare
 * i128 or wrapped in a map under a `share_amount` / `shares` / `amount` key
 * (Soroswap and friends bundle several figures into the deposit/withdraw value).
 * Returns a non-negative decimal string, or null if no amount can be found.
 */
export function extractShares(value: StellarSdk.xdr.ScVal): string | null {
  let native: unknown;
  try {
    native = scValToNative(value);
  } catch {
    return null;
  }
  return sharesFromNative(native);
}

const SHARE_KEYS = ["share_amount", "shares", "share", "amount", "liquidity"];

function sharesFromNative(native: unknown): string | null {
  if (typeof native === "bigint") return absString(native);
  if (typeof native === "number" && Number.isFinite(native)) return absString(BigInt(native));
  if (native !== null && typeof native === "object" && !Array.isArray(native)) {
    const map = native as Record<string, unknown>;
    for (const key of SHARE_KEYS) {
      if (key in map) {
        const found = sharesFromNative(map[key]);
        if (found !== null) return found;
      }
    }
  }
  return null;
}

/** Absolute value of an i128 as a decimal string — shares are never negative. */
function absString(v: bigint): string {
  return (v < 0n ? -v : v).toString();
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * True when an event looks like a liquidity-pool deposit or withdrawal that
 * moves LP shares: a recognised symbol, at least one address topic, and a
 * decodable share amount.
 */
export function isLpShareEvent(raw: RawEvent, knownPools?: ReadonlySet<string>): boolean {
  const sym = eventSymbol(raw);
  if (sym === null) return false;
  if (!DEPOSIT_EVENTS.has(sym) && !WITHDRAW_EVENTS.has(sym)) return false;
  // A generic token mint/burn only counts if we already know this contract is
  // a pool. Everything else is an ordinary SEP-41 token doing ordinary things.
  if (isBareTokenSymbol(sym) && !knownPools?.has(raw.contractId)) return false;
  if (extractShares(raw.value) === null) return false;
  return providerAddress(raw, sym) !== null;
}

/**
 * Resolve the provider (the LP whose share balance changed) for an event.
 *
 * For mint the recipient is topics[2] (topics[1] is the admin/pool, ignored);
 * every other recognised dialect carries the provider in topics[1].
 */
function providerAddress(raw: RawEvent, sym: string): string | null {
  const topic = raw.topic ?? [];
  if (sym === "mint") {
    return topic.length >= 3 ? decodeAddress(topic[2]) : null;
  }
  return topic.length >= 2 ? decodeAddress(topic[1]) : null;
}

// ─── Decoding ─────────────────────────────────────────────────────────────────

/**
 * Decode a single raw event into an LpShareTransferRecord, or null if it is not
 * a recognised LP deposit/withdraw. Never throws.
 */
export function parseLpShareEvent(
  raw: RawEvent,
  knownPools?: ReadonlySet<string>,
): LpShareTransferRecord | null {
  const sym = eventSymbol(raw);
  if (sym === null) return null;

  const isDeposit = DEPOSIT_EVENTS.has(sym);
  const isWithdraw = WITHDRAW_EVENTS.has(sym);
  if (!isDeposit && !isWithdraw) return null;

  // See the dialect note above: bare mint/burn is only an LP-share movement
  // when the emitting contract is already established as a pool.
  if (isBareTokenSymbol(sym) && !knownPools?.has(raw.contractId)) return null;

  const shares = extractShares(raw.value);
  if (shares === null) return null;

  const provider = providerAddress(raw, sym);
  if (provider === null) return null;

  const { contractId, ledger, ledgerClosedAt, txHash, id: eventId } = raw;

  return {
    poolId: contractId,
    action: isDeposit ? "deposit" : "withdraw",
    // Deposit mints shares *to* the provider; withdraw burns them *from* it.
    fromAddress: isDeposit ? null : provider,
    toAddress: isDeposit ? provider : null,
    shares,
    ledger,
    ledgerClosedAt: new Date(ledgerClosedAt),
    txHash,
    eventId,
  };
}

/**
 * Decode a batch of raw events into LP-share transfers, skipping any that are
 * not recognised LP deposits/withdrawals.
 */
export function parseLpShareEvents(
  rawEvents: RawEvent[],
  knownPools: ReadonlySet<string> = new Set(),
): LpShareTransferRecord[] {
  // First pass: a contract that emits the explicit dialect anywhere in this
  // batch is a pool, so its bare mint/burn in the *same* batch counts too.
  // Without this, a pool's first-ever deposit and the mint it emits alongside
  // would be split across the ordering of a single batch.
  const pools = new Set(knownPools);
  for (const raw of rawEvents) {
    const sym = eventSymbol(raw);
    if (sym !== null && isExplicitPoolSymbol(sym)) pools.add(raw.contractId);
  }

  const records: LpShareTransferRecord[] = [];
  for (const raw of rawEvents) {
    const record = parseLpShareEvent(raw, pools);
    if (record) records.push(record);
  }
  return records;
}

// ─── Persistence ────────────────────────────────────────────────────────────

/**
 * Idempotently insert LP-share transfers. Conflicts on `eventId` are ignored —
 * replaying an overlapping ledger range never duplicates a row. Returns the
 * number of rows newly inserted.
 */
export async function upsertLpShareTransfers(
  records: LpShareTransferRecord[],
  network?: Network,
): Promise<number> {
  if (records.length === 0) return 0;

  const net = resolveNetwork(network);
  const result = await prisma.lpShareTransfer.createMany({
    data: records.map((record) => ({ ...record, network: net })),
    skipDuplicates: true,
  });

  return result.count;
}
