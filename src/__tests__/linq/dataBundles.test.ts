/**
 * The data bundle catalogue behind `GET /ngn/bills/data-bundles`.
 *
 * The route itself is a filter and a JSON response, so the behaviour worth
 * pinning lives in `listDataBundles`: how it matches a provider, and the fact
 * that it hands back copies. That last one is the reason a caller cannot
 * quietly corrupt the catalogue for every later request in the process.
 */
import { listDataBundles } from "../../linq/bills";

describe("listDataBundles", () => {
  it("lists every provider's bundles when none is named", () => {
    const all = listDataBundles();
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all.map((b) => b.provider)).size).toBeGreaterThan(1);
  });

  it("filters by provider case-insensitively", () => {
    const upper = listDataBundles("MTN");
    const lower = listDataBundles("mtn");
    const padded = listDataBundles("  mtn  ");

    expect(upper.length).toBeGreaterThan(0);
    expect(lower).toEqual(upper);
    expect(padded).toEqual(upper);
    expect(upper.every((b) => b.provider === "MTN")).toBe(true);
  });

  it("returns nothing for a provider that is not in the catalogue", () => {
    expect(listDataBundles("NOT_A_NETWORK")).toEqual([]);
  });

  it("hands back copies, so a caller cannot mutate the catalogue", () => {
    const first = listDataBundles("MTN");
    const originalLabel = first[0].label;
    first[0].label = "tampered";

    expect(listDataBundles("MTN")[0].label).toBe(originalLabel);
  });

  it("gives every bundle the fields the response schema promises", () => {
    for (const bundle of listDataBundles()) {
      expect(typeof bundle.provider).toBe("string");
      // `code` is the opaque identifier a client passes back when buying; it is
      // documented as not-to-be-parsed, so the only assertion is that it exists.
      expect(bundle.code.length).toBeGreaterThan(0);
      expect(Number.isInteger(bundle.megabytes)).toBe(true);
      expect(Number.isInteger(bundle.validityDays)).toBe(true);
      expect(bundle.amountNgn).toBeGreaterThan(0);
    }
  });
});
