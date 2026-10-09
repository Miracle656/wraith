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

  it.each(["OR", "or", "and or", "C''OR"])(
    "keeps logical-operator text inside the quoted substring %s",
    (literal) => {
      expect(parseODataFilter(`contains(contractId,'${literal}')`, fields)).toEqual({
        contractId: { contains: literal.replace(/''/g, "'"), mode: "insensitive" },
      });
    },
  );

  it.each([" and ", " AND ", "\tand\t", "\nand\n"])(
    "splits an AND combination with separator %j outside the string",
    (separator) => {
      expect(parseODataFilter(`contains(contractId,'OR')${separator}ledger gt 100`, fields)).toEqual({
        AND: [
          { contractId: { contains: "OR", mode: "insensitive" } },
          { ledger: { gt: 100 } },
        ],
      });
    },
  );

  it("preserves escaped quotes and AND text in an equality literal", () => {
    expect(parseODataFilter("contractId eq 'C''OR and D' and ledger eq 100", fields)).toEqual({
      AND: [{ contractId: "C'OR and D" }, { ledger: 100 }],
    });
  });

  it.each([" or ", " OR ", "\tor\t"])(
    "still rejects an OR operator outside a quoted string (%j)",
    (separator) => {
      expect(() => parseODataFilter(`contains(contractId,'OR')${separator}ledger eq 100`, fields))
        .toThrow(/AND combinations/i);
    },
  );

  it("parses a projection list and rejects unknown fields", () => {
    expect(parseODataSelect("contractId, ledger", ["contractId", "ledger"])) .toEqual(["contractId", "ledger"]);
    expect(() => parseODataSelect("contractId, hacked", ["contractId"])) .toThrow(/Unsupported \$select field/i);
  });
});
