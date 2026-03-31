import * as StellarSdk from "@stellar/stellar-sdk";
import type { RawEvent } from "./rpc";
import type { TransferRecord } from "./db";

// ─── Recognised event types ───────────────────────────────────────────────────
// SEP-41 / CAP-67 standard topic[0] symbols
const KNOWN_EVENT_TYPES = new Set(["transfer", "mint", "burn", "clawback"]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Safely decode an ScVal to its native JS equivalent using stellar-sdk.
 * Returns null if decoding fails so we can skip malformed events gracefully.
 */
function decode(scVal: StellarSdk.xdr.ScVal): unknown {
  try {
    return StellarSdk.scValToNative(scVal);
  } catch {
    return null;
  }
}

/**
 * Decode an Address ScVal to a Stellar/contract address string (G... or C...).
 * Returns null if the ScVal is not an address type.
 */
function decodeAddress(scVal: StellarSdk.xdr.ScVal): string | null {
  try {
    if (scVal.switch() !== StellarSdk.xdr.ScValType.scvAddress()) return null;
    const addr = StellarSdk.Address.fromScVal(scVal);
    return addr.toString();
  } catch {
    return null;
  }
}

/**
 * Decode an i128 ScVal to a decimal string.
 * i128 values are two i64s: hi (signed) and lo (unsigned).
 */
function decodeI128(scVal: StellarSdk.xdr.ScVal): string | null {
  try {
    const native = StellarSdk.scValToNative(scVal);
    // scValToNative converts i128 to BigInt in newer stellar-sdk versions.
    if (typeof native === "bigint") return native.toString();
    // Fallback: handle as number (may lose precision for very large amounts).
    if (typeof native === "number") return native.toString();
    return String(native);
  } catch {
    return null;
  }
}

// ─── Main parser ──────────────────────────────────────────────────────────────

/**
 * Parse a single raw RPC event into a normalised TransferRecord.
 *
 * SEP-41 event structures:
 *
 *   transfer:
 *     topics[0] = Symbol("transfer")
 *     topics[1] = Address(from)
 *     topics[2] = Address(to)
 *     value     = i128(amount)
 *
 *   mint:
 *     topics[0] = Symbol("mint")
 *     topics[1] = Address(admin)   ← NOT the from for our purposes
 *     topics[2] = Address(to)
 *     value     = i128(amount)
 *
 *   burn:
 *     topics[0] = Symbol("burn")
 *     topics[1] = Address(from)
 *     value     = i128(amount)
 *
 *   clawback:
 *     topics[0] = Symbol("clawback")
 *     topics[1] = Address(from)    ← the account being clawed back
 *     value     = i128(amount)
 *
 * Returns null if the event is not a recognised token event or is malformed.
 */
export function parseEvent(
  raw: RawEvent
): TransferRecord | null {
  const { topic, value, contractId, ledger, ledgerClosedAt, txHash, id: eventId } = raw;

  // ── Sanity checks ─────────────────────────────────────────
  if (!topic || topic.length === 0) return null;

  // topics[0] must be a Symbol naming the event type
  const eventTypeDec = decode(topic[0]);
  if (typeof eventTypeDec !== "string") return null;
  const eventType = eventTypeDec.toLowerCase();
  if (!KNOWN_EVENT_TYPES.has(eventType)) return null;

  // ── Decode amount (value) ─────────────────────────────────
  const amount = decodeI128(value);
  if (amount === null) return null;

  // ── Decode addresses by event type ───────────────────────
  let fromAddress: string | null = null;
  let toAddress: string | null = null;

  if (eventType === "transfer") {
    // topics[1] = from, topics[2] = to
    if (topic.length < 3) return null;
    fromAddress = decodeAddress(topic[1]);
    toAddress = decodeAddress(topic[2]);
    if (!fromAddress || !toAddress) return null;

  } else if (eventType === "mint") {
    // topics[1] = admin (ignored as "from"), topics[2] = to recipient
    if (topic.length < 3) return null;
    toAddress = decodeAddress(topic[2]);
    if (!toAddress) return null;
    // fromAddress stays null — it's a mint, no sender

  } else if (eventType === "burn" || eventType === "clawback") {
    // topics[1] = from (the holder being burned/clawed)
    if (topic.length < 2) return null;
    fromAddress = decodeAddress(topic[1]);
    if (!fromAddress) return null;
    // toAddress stays null
  }

  return {
    contractId,
    eventType,
    fromAddress,
    toAddress,
    amount,
    ledger,
    ledgerClosedAt: new Date(ledgerClosedAt),
    txHash,
    eventId,
  };
}

/**
 * Parse a batch of raw events, silently skipping unrecognised or malformed ones.
 * Logs a count of skipped events at debug level.
 */
export function parseEvents(rawEvents: RawEvent[]): TransferRecord[] {
  const records: TransferRecord[] = [];
  let skipped = 0;

  for (const raw of rawEvents) {
    const record = parseEvent(raw);
    if (record) {
      records.push(record);
    } else {
      skipped++;
    }
  }

  if (skipped > 0) {
    console.debug(`[parser] Skipped ${skipped} non-token events out of ${rawEvents.length}`);
  }

  return records;
}
