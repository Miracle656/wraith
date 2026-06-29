/**
 * Stellar Asset Contract (SAC) detection (#136).
 *
 * A SAC is the canonical contract that wraps a *classic* Stellar asset (native
 * XLM or a `CODE:ISSUER` credit) so it can be used from Soroban. Unlike an
 * ordinary Soroban token — whose contract instance points at uploaded Wasm via
 * a code hash — a SAC's instance carries the special "Stellar Asset" executable
 * built into the host. Detecting this lets consumers tell a wrapped classic
 * asset apart from a native Soroban token.
 *
 * Detection strategy:
 *   1. Read the contract's instance ledger entry (the ContractData entry keyed
 *      by `ScVal::LedgerKeyContractInstance`).
 *   2. Inspect its executable: SACs use `ContractExecutableStellarAsset`, Wasm
 *      tokens use `ContractExecutableWasm(hash)`.
 *
 * Results are immutable for the lifetime of a contract, so they are cached in
 * memory keyed by contract ID.
 */

import { xdr } from "@stellar/stellar-sdk";
import { getRpc } from "../rpc";

// ─── Known SACs ───────────────────────────────────────────────────────────────
// The native XLM SAC on mainnet and testnet. These are fixed by the network and
// never change, so we short-circuit detection (and any RPC call) for them.
const KNOWN_SAC_IDS = new Set<string>([
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", // mainnet native XLM
  "CDMLFMKMMD7MWZP3FKUBZPVHTUEDLSX4BYGYKH4GCESXYHS3IHQ4EIG4", // testnet native XLM
]);

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * True when a contract executable is the built-in Stellar Asset executable
 * (i.e. the contract is a SAC) rather than uploaded Wasm.
 */
export function executableIsSac(executable: xdr.ContractExecutable): boolean {
  return (
    executable.switch().value ===
    xdr.ContractExecutableType.contractExecutableStellarAsset().value
  );
}

/**
 * True when a decoded contract-instance ScVal describes a SAC.
 * Returns false for any non-instance value.
 */
export function instanceValIsSac(val: xdr.ScVal): boolean {
  if (val.switch().value !== xdr.ScValType.scvContractInstance().value) {
    return false;
  }
  return executableIsSac(val.instance().executable());
}

// ─── Instance fetch ───────────────────────────────────────────────────────────

/**
 * Fetches the decoded contract-instance ScVal for a contract, or null if the
 * contract has no instance entry / the lookup fails. Injectable for testing.
 */
export type InstanceFetcher = (contractId: string) => Promise<xdr.ScVal | null>;

async function fetchInstanceVal(contractId: string): Promise<xdr.ScVal | null> {
  try {
    const entry = await getRpc().getContractData(
      contractId,
      xdr.ScVal.scvLedgerKeyContractInstance(),
    );
    return entry.val.contractData().val();
  } catch {
    // Missing entry, archived state, or RPC error — treat as "not determinable".
    return null;
  }
}

// ─── Cached detection ─────────────────────────────────────────────────────────

const cache = new Map<string, boolean>();

/**
 * Detect whether `contractId` is a Stellar Asset Contract. Cached per contract.
 *
 * @param contractId    The C... contract address to classify.
 * @param fetchInstance Override the instance fetcher (used in tests).
 */
export async function detectSac(
  contractId: string,
  fetchInstance: InstanceFetcher = fetchInstanceVal,
): Promise<boolean> {
  if (KNOWN_SAC_IDS.has(contractId)) return true;

  const cached = cache.get(contractId);
  if (cached !== undefined) return cached;

  const val = await fetchInstance(contractId);
  const isSac = val !== null && instanceValIsSac(val);
  cache.set(contractId, isSac);
  return isSac;
}

/**
 * Resolve SAC status for many contracts at once, de-duplicating IDs so each
 * unique contract is looked up at most once. Returns a Map keyed by contract ID.
 */
export async function detectSacBatch(
  contractIds: Iterable<string>,
  fetchInstance: InstanceFetcher = fetchInstanceVal,
): Promise<Map<string, boolean>> {
  const unique = [...new Set(contractIds)];
  const results = await Promise.all(
    unique.map(async (id) => [id, await detectSac(id, fetchInstance)] as const),
  );
  return new Map(results);
}

/**
 * Tag a batch of transfer-like records (anything carrying a `contractId` and a
 * mutable `isSac`) with their SAC status. Records are mutated in place and also
 * returned for convenience. One RPC lookup per unique, unknown contract.
 */
export async function tagSacTransfers<T extends { contractId: string; isSac?: boolean }>(
  records: T[],
  fetchInstance: InstanceFetcher = fetchInstanceVal,
): Promise<T[]> {
  if (records.length === 0) return records;
  const byContract = await detectSacBatch(
    records.map((r) => r.contractId),
    fetchInstance,
  );
  for (const record of records) {
    record.isSac = byContract.get(record.contractId) ?? false;
  }
  return records;
}

/** Clear the in-memory SAC cache. Intended for tests. */
export function _clearSacCache(): void {
  cache.clear();
}
