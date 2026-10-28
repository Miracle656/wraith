/**
 * Veil Names pricing and validation.
 *
 * The assertions that matter here are the ones about two spellings being one
 * name. Federation resolves a name to an address somebody sends money to, so a
 * case or charset hole is a payment-redirect bug, not a cosmetic one.
 */
import {
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

describe("name pricing by length", () => {
  it("prices a three-character name at 10 USDC", () => {
    const got = checkName("abc");
    expect(got).toEqual({ ok: true, name: "abc", priceUsdc: 10 });
  });

  it("prices a four-character name at 5 USDC", () => {
    const got = checkName("abcd");
    expect(got).toEqual({ ok: true, name: "abcd", priceUsdc: 5 });
  });

  it("prices every length from five up at the flat long price", () => {
    for (let len = 5; len <= MAX_NAME_LENGTH; len++) {
      const name = "a".repeat(len);
      expect(checkName(name)).toEqual({ ok: true, name, priceUsdc: LONG_NAME_PRICE_USDC });
    }
  });

  it("charges strictly more for shorter names", () => {
    // The whole point of length pricing. If this inverts, scarcity is priced
    // backwards and the 46,656 three-character names go at the bulk rate.
    expect(priceForLength(3)).toBeGreaterThan(priceForLength(4));
    expect(priceForLength(4)).toBeGreaterThan(priceForLength(5));
    expect(priceForLength(5)).toBe(priceForLength(31));
  });
});

describe("normalization — two spellings must not be two names", () => {
  it("folds case, so Jack and jack are one name", () => {
    expect(normalizeName("Jack")).toBe("jack");
    expect(normalizeName("JACK")).toBe("jack");
    const a = checkName("Jack");
    const b = checkName("jACK");
    expect(a).toEqual(b);
  });

  it("strips surrounding whitespace from paste", () => {
    // Four characters once trimmed, so this also pins that the price is read
    // from the normalized name and not from the raw input's length.
    expect(checkName("  jack  ")).toEqual({ ok: true, name: "jack", priceUsdc: 5 });
  });

  it("refuses a Cyrillic homoglyph rather than folding it", () => {
    // "jаck" with U+0430. It reads as "jack" and must never be sellable: a
    // holder of it would receive payments meant for the real name.
    const got = checkName("jаck");
    expect(got).toEqual({ ok: false, reason: "bad_charset" });
  });

  it("refuses other non-ASCII and punctuation outright", () => {
    for (const bad of ["jack!", "ja ck", "jack.", "ja_ck", "jack​", "émile", "ja/ck", "ja*ck"]) {
      expect(checkName(bad)).toEqual({ ok: false, reason: "bad_charset" });
    }
  });
});

describe("length bounds", () => {
  it("refuses one- and two-character names as too short, not as invalid", () => {
    // They are withheld, not malformed — the distinction is what a client
    // tells the user, and "reserved" is the truthful answer.
    expect(checkName("a")).toEqual({ ok: false, reason: "too_short" });
    expect(checkName("ab")).toEqual({ ok: false, reason: "too_short" });
    expect(MIN_SELLABLE_LENGTH).toBe(3);
  });

  it("refuses an empty or whitespace-only candidate", () => {
    expect(checkName("")).toEqual({ ok: false, reason: "empty" });
    expect(checkName("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("accepts exactly the maximum length and refuses one past it", () => {
    expect(checkName("a".repeat(MAX_NAME_LENGTH)).ok).toBe(true);
    expect(checkName("a".repeat(MAX_NAME_LENGTH + 1))).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("hyphens", () => {
  it("allows an interior hyphen", () => {
    expect(checkName("jack-ng")).toEqual({ ok: true, name: "jack-ng", priceUsdc: 2 });
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
    // 2 USDC tier that reads as support in every UI that renders it.
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
