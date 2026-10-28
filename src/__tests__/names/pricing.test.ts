/**
 * Veil Names pricing and validation.
 *
 * Two groups of assertions. The pricing ones pin a deliberately non-monotonic
 * curve, so they exist partly to stop someone "fixing" it into the descending
 * shape every other registry uses. The validation ones are the load-bearing
 * half: federation resolves a name to an address somebody sends money to, so a
 * case or charset hole is a payment-redirect bug, not a cosmetic one.
 */
import {
  LONG_NAME_MIN_LENGTH,
  LONG_NAME_PRICE_USDC,
  MAX_NAME_LENGTH,
  MIN_SELLABLE_LENGTH,
  NFT_COLLECTION_SIZE,
  NFT_PRICE_USDC,
  checkName,
  isReserved,
  normalizeName,
  priceForLength,
} from "../../names/pricing";

describe("name pricing by length band", () => {
  it("prices 1 to 5 characters at 3 USDC", () => {
    for (let len = 1; len <= 5; len++) {
      expect(priceForLength(len)).toBe(3);
    }
  });

  it("prices 6 to 10 characters at 5 USDC", () => {
    for (let len = 6; len <= 10; len++) {
      expect(priceForLength(len)).toBe(5);
    }
  });

  it("prices 11 characters and up at 2 USDC", () => {
    for (let len = 11; len <= MAX_NAME_LENGTH; len++) {
      expect(priceForLength(len)).toBe(LONG_NAME_PRICE_USDC);
    }
    expect(LONG_NAME_MIN_LENGTH).toBe(11);
  });

  it("puts the boundaries on 5/6 and 10/11, not one off either way", () => {
    expect(priceForLength(5)).toBe(3);
    expect(priceForLength(6)).toBe(5);
    expect(priceForLength(10)).toBe(5);
    expect(priceForLength(11)).toBe(2);
  });

  it("keeps the middle band dearest, which is intentional", () => {
    // Demand pricing, not scarcity pricing: real first names are 6-10
    // characters, so that is where the asking is. If a later change makes this
    // descend, the pricing decision was reversed and somebody should say so.
    expect(priceForLength(7)).toBeGreaterThan(priceForLength(3));
    expect(priceForLength(7)).toBeGreaterThan(priceForLength(20));
    expect(priceForLength(20)).toBeLessThan(priceForLength(3));
  });

  it("prices a real name through the full gate", () => {
    expect(checkName("ade")).toEqual({ ok: true, name: "ade", priceUsdc: 3 });
    expect(checkName("adebayo")).toEqual({ ok: true, name: "adebayo", priceUsdc: 5 });
    expect(checkName("adebayoakinola")).toEqual({
      ok: true,
      name: "adebayoakinola",
      priceUsdc: 2,
    });
  });
});

describe("normalization — two spellings must not be two names", () => {
  it("folds case, so Jack and jack are one name", () => {
    expect(normalizeName("Jack")).toBe("jack");
    expect(normalizeName("JACK")).toBe("jack");
    expect(checkName("Jack")).toEqual(checkName("jACK"));
  });

  it("strips surrounding whitespace from paste", () => {
    // Four characters once trimmed, so this also pins that the price is read
    // from the normalized name and not from the raw input's length.
    expect(checkName("  jack  ")).toEqual({ ok: true, name: "jack", priceUsdc: 3 });
  });

  it("refuses a Cyrillic homoglyph rather than folding it", () => {
    // "jаck" with U+0430. It reads as "jack" and must never be sellable: a
    // holder of it would receive payments meant for the real name.
    expect(checkName("jаck")).toEqual({ ok: false, reason: "bad_charset" });
  });

  it("refuses other non-ASCII and punctuation outright", () => {
    for (const bad of ["jack!", "ja ck", "jack.", "ja_ck", "jack​", "émile", "ja/ck", "ja*ck"]) {
      expect(checkName(bad)).toEqual({ ok: false, reason: "bad_charset" });
    }
  });
});

describe("length bounds", () => {
  it("withholds one- and two-character names despite the band covering them", () => {
    // The 1-5 band prices them at 3 USDC, but they are not on sale: 36 and
    // 1,296 of them exist, nothing here is upgradeable, and a name sold is
    // sold permanently. Withholding is reversible; selling is not. Flip
    // MIN_SELLABLE_LENGTH to 1 to open them.
    expect(priceForLength(1)).toBe(3);
    expect(priceForLength(2)).toBe(3);
    expect(checkName("a")).toEqual({ ok: false, reason: "too_short" });
    expect(checkName("ab")).toEqual({ ok: false, reason: "too_short" });
    expect(MIN_SELLABLE_LENGTH).toBe(3);
  });

  it("refuses an empty or whitespace-only candidate", () => {
    expect(checkName("")).toEqual({ ok: false, reason: "empty" });
    expect(checkName("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("accepts exactly the maximum length and refuses one past it", () => {
    expect(checkName("a".repeat(MAX_NAME_LENGTH))).toEqual({
      ok: true,
      name: "a".repeat(MAX_NAME_LENGTH),
      priceUsdc: 2,
    });
    expect(checkName("a".repeat(MAX_NAME_LENGTH + 1))).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("hyphens", () => {
  it("allows an interior hyphen", () => {
    expect(checkName("jack-ng")).toEqual({ ok: true, name: "jack-ng", priceUsdc: 5 });
  });

  it("refuses a leading, trailing or doubled hyphen", () => {
    for (const bad of ["-jack", "jack-", "ja--ck", "-", "--"]) {
      const got = checkName(bad);
      expect(got.ok).toBe(false);
      if (!got.ok) expect(["bad_hyphen", "too_short"]).toContain(got.reason);
    }
  });
});

describe("reserved names", () => {
  it("refuses names that would let a stranger be mistaken for Veil", () => {
    for (const name of ["veil", "support", "admin", "payments", "security", "kyc"]) {
      expect(checkName(name)).toEqual({ ok: false, reason: "reserved" });
    }
  });

  it("refuses a reserved name hyphenated to sneak past the list", () => {
    // Without hyphen-stripping, `s-u-p-p-o-r-t` is a 13-character name at the
    // cheapest tier that reads as support in every screen that renders it.
    expect(isReserved("s-u-p-p-o-r-t")).toBe(true);
    expect(checkName("s-u-p-p-o-r-t")).toEqual({ ok: false, reason: "reserved" });
    expect(checkName("ve-il")).toEqual({ ok: false, reason: "reserved" });
  });

  it("refuses a reserved name in mixed case", () => {
    expect(checkName("SuPPort")).toEqual({ ok: false, reason: "reserved" });
  });

  it("still allows a name that merely contains a reserved word", () => {
    // `isReserved` is exact-match on the whole name, not a substring ban:
    // banning substrings would refuse most of the dictionary.
    expect(checkName("jackapi").ok).toBe(true);
    expect(checkName("teamjack").ok).toBe(true);
  });
});

describe("the figures", () => {
  it("prices every figure the same, at 5 USDC", () => {
    expect(NFT_PRICE_USDC).toBe(5);
  });

  it("is a set of twenty", () => {
    expect(NFT_COLLECTION_SIZE).toBe(20);
  });
});
