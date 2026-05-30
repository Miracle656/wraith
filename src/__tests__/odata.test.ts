import { parseODataFilter, parseODataSelect } from "../lib/odata";

describe("OData helper", () => {
  const fields = {
    contractId: { type: "string" as const },
    ledger: { type: "number" as const },
    ledgerClosedAt: { type: "date" as const },
    eventType: { type: "string" as const },
  };

  it("parses a safe AND-only filter", () => {
    expect(parseODataFilter("ledger gt 100 and contains(contractId,'C')", fields)).toEqual({
      AND: [
        { ledger: { gt: 100 } },
        { contractId: { contains: "C", mode: "insensitive" } },
      ],
    });
  });

  it("rejects unsafe or unsupported filter expressions", () => {
    expect(() => parseODataFilter("ledger gt 100 or 1 eq 1", fields)).toThrow(/AND combinations/i);
    expect(() => parseODataFilter("contains(ledger,'1')", fields)).toThrow(/string fields/i);
  });

  it("parses a projection list and rejects unknown fields", () => {
    expect(parseODataSelect("contractId, ledger", ["contractId", "ledger"])) .toEqual(["contractId", "ledger"]);
    expect(() => parseODataSelect("contractId, hacked", ["contractId"])) .toThrow(/Unsupported \$select field/i);
  });
});