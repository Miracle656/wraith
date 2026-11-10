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
import { resolveNetwork, type Network } from "../network";

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

/**
 * A mint or a burn of a non-fungible token.
 *
 * These are not transfers and do not look like them. `stellar-tokens` emits
 *
 *     mint: topics = (Symbol("mint"), Address(to)),   data = u32(token_id)
 *     burn: topics = (Symbol("burn"), Address(from)), data = u32(token_id)
 *
 * — two topics, where a transfer has four, and the token id in the DATA rather
 * than a topic. `isNftTransferEvent` requires four topics and `"transfer"`, so
 * for a long time a minted NFT was invisible to this indexer until somebody
 * sent it on. Both Veil Names and Veil-ians mint straight to the buyer and are
 * usually never transferred at all, so their holders were shown an empty
 * gallery over a token the chain had recorded.
 *
 * The discriminator against a FUNGIBLE burn — which is also two topics,
 * `(Symbol("burn"), Address(from))` — is the data type: a token id is `u32`,
 * an amount is `i128`. Matching on the symbol alone would file every fungible
 * burn in the chain as an NFT.
 */
export function isNftMintOrBurnEvent(raw: RawEvent): boolean {
  if (!raw.topic || raw.topic.length !== 2) return false;
  try {
    const sym = scValToNative(raw.topic[0]);
    if (sym !== "mint" && sym !== "burn") return false;
    if (raw.topic[1].switch() !== xdr.ScValType.scvAddress()) return false;
    // A token id, not an amount.
    if (raw.value.switch() !== xdr.ScValType.scvU32()) return false;
  } catch {
    return false;
  }
  return true;
}

/** Any event this module can turn into a holding change. */
export function isNftEvent(raw: RawEvent): boolean {
  return isNftTransferEvent(raw) || isNftMintOrBurnEvent(raw);
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
  const { topic, contractId, ledger, ledgerClosedAt, txHash, id: eventId } = raw;

  // A mint has no sender and a burn has no recipient; the record type has
  // always allowed both to be null, and `currentHoldings` already reads
  // ownership off `toAddress`, so a mint lands as a holding with nothing else
  // to change.
  if (isNftMintOrBurnEvent(raw)) {
    try {
      const party = Address.fromScVal(topic[1]).toString();
      const minting = scValToNative(topic[0]) === "mint";
      return {
        contractId,
        tokenId: decodeTokenId(raw.value),
        fromAddress: minting ? null : party,
        toAddress: minting ? party : null,
        ledger,
        ledgerClosedAt: new Date(ledgerClosedAt),
        txHash,
        eventId,
      };
    } catch {
      return null;
    }
  }

  if (!isNftTransferEvent(raw)) return null;
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
    if (!isNftEvent(raw)) continue;
    const record = parseNftTransferEvent(raw);
    if (record) {
      // The token id is a topic on a transfer and the data on a mint or burn.
      results.push({ record, tokenIdScVal: isNftTransferEvent(raw) ? raw.topic[3] : raw.value });
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
  tokenIdScVal: xdr.ScVal,
  network?: Network
): Promise<NftMetadataPayload> {
  // Read from the caller's network rather than the process-wide env var: with
  // one loop per network, a module-level lookup would sign every simulation
  // with whichever passphrase happened to be configured, so a mainnet metadata
  // read would be built against the testnet passphrase and simulate wrongly.
  const net = resolveNetwork(network);
  const networkPassphrase = net === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

  // Any valid address works as a simulation source — it doesn't need funds.
  const dummy = new Account(
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    "0"
  );
  const contract = new Contract(contractId);
  const rpc = getRpc(net);
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
