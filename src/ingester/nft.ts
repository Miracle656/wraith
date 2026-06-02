import {
  scValToNative,
  Address,
  Contract,
  TransactionBuilder,
  Account,
  Networks,
  xdr,
} from "@stellar/stellar-sdk";
import type { RawEvent } from "../rpc";
import { getRpc } from "../rpc";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NftTransferRecord {
  contractId: string;
  tokenId: string;
  fromAddress: string | null;
  toAddress: string | null;
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  eventId: string;
}

export interface NftMetadataPayload {
  name?: string;
  tokenUri?: string;
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * CAP-46 NFT transfer events have 4 topics:
 *   [Symbol("transfer"), Address(from), Address(to), ScVal(token_id)]
 * and a void value — distinguishing them from SEP-41 fungible transfers which
 * have 3 topics and an i128 amount as the value.
 */
export function isNftTransferEvent(raw: RawEvent): boolean {
  if (!raw.topic || raw.topic.length < 4) return false;
  try {
    const sym = scValToNative(raw.topic[0]);
    if (sym !== "transfer") return false;
    if (raw.topic[1].switch() !== xdr.ScValType.scvAddress()) return false;
    if (raw.topic[2].switch() !== xdr.ScValType.scvAddress()) return false;
  } catch {
    return false;
  }
  return true;
}

// ─── Decoding ─────────────────────────────────────────────────────────────────

function decodeTokenId(scVal: xdr.ScVal): string {
  try {
    const native = scValToNative(scVal);
    if (typeof native === "bigint") return native.toString();
    if (typeof native === "number") return String(native);
    if (native instanceof Uint8Array) return Buffer.from(native).toString("hex");
    if (typeof native === "string") return native;
    return String(native);
  } catch {
    // Fall back to raw XDR base64 so we never lose the event
    return scVal.toXDR("base64");
  }
}

/**
 * Parse a single raw RPC event into a NftTransferRecord.
 * Returns null for non-NFT events; never throws.
 */
export function parseNftTransferEvent(raw: RawEvent): NftTransferRecord | null {
  if (!isNftTransferEvent(raw)) return null;
  const { topic, contractId, ledger, ledgerClosedAt, txHash, id: eventId } = raw;
  try {
    const fromAddress = Address.fromScVal(topic[1]).toString();
    const toAddress = Address.fromScVal(topic[2]).toString();
    const tokenId = decodeTokenId(topic[3]);
    return {
      contractId,
      tokenId,
      fromAddress,
      toAddress,
      ledger,
      ledgerClosedAt: new Date(ledgerClosedAt),
      txHash,
      eventId,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a batch of raw events, returning only NFT transfer records.
 */
export function parseNftEvents(
  rawEvents: RawEvent[]
): Array<{ record: NftTransferRecord; tokenIdScVal: xdr.ScVal }> {
  const results: Array<{ record: NftTransferRecord; tokenIdScVal: xdr.ScVal }> = [];
  for (const raw of rawEvents) {
    if (!isNftTransferEvent(raw)) continue;
    const record = parseNftTransferEvent(raw);
    if (record) {
      results.push({ record, tokenIdScVal: raw.topic[3] });
    }
  }
  return results;
}

// ─── Metadata fetch ───────────────────────────────────────────────────────────

/**
 * Lazily fetch NFT metadata by simulating contract calls.
 * Tries `token_uri(token_id)` and `name()` — both optional by spec.
 * Never throws; returns whatever could be fetched.
 */
export async function fetchNftMetadata(
  contractId: string,
  tokenIdScVal: xdr.ScVal
): Promise<NftMetadataPayload> {
  const network = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  const networkPassphrase =
    network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

  // Any valid address works as a simulation source — it doesn't need funds.
  const dummy = new Account(
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    "0"
  );
  const contract = new Contract(contractId);
  const rpc = getRpc();
  const result: NftMetadataPayload = {};

  // Try token_uri(token_id)
  try {
    const tx = new TransactionBuilder(dummy, { fee: "100", networkPassphrase })
      .addOperation(contract.call("token_uri", tokenIdScVal))
      .setTimeout(30)
      .build();
    const sim = await rpc.simulateTransaction(tx);
    if ("result" in sim && sim.result) {
      const val = scValToNative(sim.result.retval);
      if (typeof val === "string") result.tokenUri = val;
    }
  } catch {
    // function absent or simulation failure — skip silently
  }

  // Try name() for the collection name
  try {
    const tx = new TransactionBuilder(dummy, { fee: "100", networkPassphrase })
      .addOperation(contract.call("name"))
      .setTimeout(30)
      .build();
    const sim = await rpc.simulateTransaction(tx);
    if ("result" in sim && sim.result) {
      const val = scValToNative(sim.result.retval);
      if (typeof val === "string") result.name = val;
    }
  } catch {
    // function absent or simulation failure — skip silently
  }

  return result;
}
