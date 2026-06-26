/**
 * Tests for SAC (Stellar Asset Contract) detection (#136).
 *
 * Covers the pure executable/instance classifiers plus the cached, injectable
 * detectSac / detectSacBatch / tagSacTransfers helpers. No network is used — a
 * fake instance fetcher is injected throughout.
 */

import { xdr } from "@stellar/stellar-sdk";
import {
  executableIsSac,
  instanceValIsSac,
  detectSac,
  detectSacBatch,
  tagSacTransfers,
  _clearSacCache,
  type InstanceFetcher,
} from "../indexer/sac-detect";

// The native XLM SACs are hard-coded as known SACs in the module.
const TESTNET_XLM_SAC = "CDMLFMKMMD7MWZP3FKUBZPVHTUEDLSX4BYGYKH4GCESXYHS3IHQ4EIG4";

function sacInstanceVal(): xdr.ScVal {
  return xdr.ScVal.scvContractInstance(
    new xdr.ScContractInstance({
      executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
      storage: null,
    }),
  );
}

function wasmInstanceVal(): xdr.ScVal {
  return xdr.ScVal.scvContractInstance(
    new xdr.ScContractInstance({
      executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 7)),
      storage: null,
    }),
  );
}

beforeEach(() => {
  _clearSacCache();
});

describe("executableIsSac", () => {
  it("is true for the Stellar Asset executable", () => {
    expect(executableIsSac(xdr.ContractExecutable.contractExecutableStellarAsset())).toBe(true);
  });

  it("is false for a Wasm executable", () => {
    expect(executableIsSac(xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32)))).toBe(false);
  });
});

describe("instanceValIsSac", () => {
  it("is true for a SAC contract instance", () => {
    expect(instanceValIsSac(sacInstanceVal())).toBe(true);
  });

  it("is false for a Wasm contract instance", () => {
    expect(instanceValIsSac(wasmInstanceVal())).toBe(false);
  });

  it("is false for a non-instance ScVal", () => {
    expect(instanceValIsSac(xdr.ScVal.scvU32(1))).toBe(false);
  });
});

describe("detectSac", () => {
  it("returns true for a known native XLM SAC without fetching", async () => {
    const fetcher = jest.fn<Promise<xdr.ScVal | null>, [string]>();
    await expect(detectSac(TESTNET_XLM_SAC, fetcher)).resolves.toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies a SAC via the injected fetcher", async () => {
    const fetcher: InstanceFetcher = async () => sacInstanceVal();
    await expect(detectSac("CSACTOKEN", fetcher)).resolves.toBe(true);
  });

  it("classifies a Wasm token as not a SAC", async () => {
    const fetcher: InstanceFetcher = async () => wasmInstanceVal();
    await expect(detectSac("CWASMTOKEN", fetcher)).resolves.toBe(false);
  });

  it("treats an unresolvable instance as not a SAC", async () => {
    const fetcher: InstanceFetcher = async () => null;
    await expect(detectSac("CUNKNOWN", fetcher)).resolves.toBe(false);
  });

  it("caches results so each contract is fetched at most once", async () => {
    const fetcher = jest.fn(async () => wasmInstanceVal());
    await detectSac("CCACHED", fetcher);
    await detectSac("CCACHED", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("detectSacBatch", () => {
  it("de-duplicates contract IDs", async () => {
    const fetcher = jest.fn(async () => sacInstanceVal());
    const result = await detectSacBatch(["CA", "CA", "CB"], fetcher);
    expect(result.get("CA")).toBe(true);
    expect(result.get("CB")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("tagSacTransfers", () => {
  it("sets isSac on every record based on its contract", async () => {
    const fetcher: InstanceFetcher = async (id) =>
      id === "CSAC" ? sacInstanceVal() : wasmInstanceVal();

    const records = [
      { contractId: "CSAC", isSac: false },
      { contractId: "CWASM", isSac: false },
      { contractId: "CSAC", isSac: false },
    ];

    await tagSacTransfers(records, fetcher);

    expect(records.map((r) => r.isSac)).toEqual([true, false, true]);
  });

  it("returns the same array reference for empty input", async () => {
    const empty: Array<{ contractId: string; isSac?: boolean }> = [];
    await expect(tagSacTransfers(empty)).resolves.toBe(empty);
  });
});
