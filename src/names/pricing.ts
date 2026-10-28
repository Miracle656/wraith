/**
 * Veil Names — what a name costs, and what counts as a name at all.
 *
 * A name is the part before the `*` in `jack*useveilapp.xyz`, resolved over
 * SEP-2 federation to a Stellar address. That makes this module money-facing
 * in a way a naming scheme usually is not: a name resolves to an address
 * somebody sends funds to, so two names a human reads as the same string must
 * never be two different names here. Everything below about normalization and
 * the rejected character set is that one rule, spelled out.
 *
 * Pricing is by length, shortest dearest, which is the registry convention and
 * matches the scarcity: there are 46,656 three-character names available under
 * this charset and effectively unlimited long ones.
 *
 * This module is pure. It touches no database, takes no payment and issues
 * nothing; it answers "is this a name" and "what does it cost". The claim
 * flow, the KYC gate and the payment are separate and call into this.
 */

/**
 * The price of a name, in USDC, by exact character count.
 *
 * `3 => 10, 4 => 5, 5+ => 2`. The 4-character tier is the one place the
 * instruction was "then do length for 5 usdc" without naming the length, and 4
 * is the only reading that leaves no gap between the 3-character tier and the
 * long tail. If that was meant to be 5 characters, change this table and the
 * tests move with it — nothing else in the system hardcodes a price.
 */
export const NAME_PRICE_USDC_BY_LENGTH: ReadonlyMap<number, number> = new Map([
  [3, 10],
  [4, 5],
]);

/** What every name at or above `LONG_NAME_MIN_LENGTH` costs, in USDC. */
export const LONG_NAME_PRICE_USDC = 2;

/** The first length that falls into the flat long-name price. */
export const LONG_NAME_MIN_LENGTH = 5;

/**
 * The shortest name that can be bought.
 *
 * One- and two-character names are deliberately NOT for sale. They are the
 * scarcest things in the namespace — 36 and 1,296 of them — and no contract
 * here is upgradeable, so a name sold is sold permanently. Holding them costs
 * nothing and sets no price wrong; selling them at the 3-character price is a
 * decision that cannot be revisited.
 */
export const MIN_SELLABLE_LENGTH = 3;

/**
 * The longest name that can be bought.
 *
 * A bound is required rather than tidy: the name is rendered in a send screen,
 * an activity row and a push notification, and an unbounded string at the
 * cheapest tier is a layout bug somebody can buy for 2 USDC.
 */
export const MAX_NAME_LENGTH = 32;

/**
 * Names nobody may buy, because holding one would let the holder be mistaken
 * for Veil itself.
 *
 * Federation turns a name into a payment destination, so
 * `support*useveilapp.xyz` in a stranger's hands is not a branding annoyance,
 * it is a phishing address that our own resolver endorses — and at the long-name
 * price it costs 2 USDC to acquire. These stay unsellable until there is a
 * verified-organization concept to hand them out under.
 */
export const RESERVED_NAMES: readonly string[] = [
  "veil",
  "veilapp",
  "useveilapp",
  "admin",
  "administrator",
  "support",
  "help",
  "helpdesk",
  "info",
  "team",
  "staff",
  "official",
  "security",
  "billing",
  "payments",
  "payment",
  "wallet",
  "deposit",
  "withdraw",
  "refund",
  "verify",
  "verification",
  "kyc",
  "root",
  "system",
  "noreply",
  "no-reply",
  "postmaster",
  "abuse",
  "legal",
  "privacy",
  "api",
  "www",
  "mail",
  "name",
  "names",
  "drips",
  "stellar",
  "soroban",
  "sdf",
];

/** Why a candidate name was refused. One of these, never free text. */
export const NAME_REJECTIONS = [
  /** Empty, or whitespace only. */
  "empty",
  /** Shorter than `MIN_SELLABLE_LENGTH` — reserved, not merely invalid. */
  "too_short",
  /** Longer than `MAX_NAME_LENGTH`. */
  "too_long",
  /**
   * Contains a character outside `[a-z0-9-]` after normalization. This is the
   * homoglyph rule: a Cyrillic "а" is not an "a", and a name that reads as
   * somebody else's is a payment redirect.
   */
  "bad_charset",
  /** A hyphen at the start or end, or two in a row. */
  "bad_hyphen",
  /** On the reserved list, including once hyphens are stripped. */
  "reserved",
] as const;
export type NameRejection = (typeof NAME_REJECTIONS)[number];

export type NameCheck =
  | { ok: true; name: string; priceUsdc: number }
  | { ok: false; reason: NameRejection };

/**
 * Fold a candidate to its canonical form.
 *
 * Case is not part of a name: `Jack`, `JACK` and `jack` are one name, and if
 * the claim path and the resolve path disagree about that, a name resolves for
 * the person who typed it one way and 404s for everybody else. Unicode is NOT
 * folded here — it is rejected by `checkName`, because folding it would be the
 * bug. `İ` lowercases to `i̇` in some locales and `i` in others, which is a
 * different address depending on the phone.
 *
 * Surrounding whitespace is stripped because it comes from paste and keyboards,
 * never from intent.
 */
export function normalizeName(candidate: string): string {
  return candidate.trim().toLowerCase();
}

/** True if `name` is reserved, ignoring hyphens used to sneak past the list. */
export function isReserved(name: string): boolean {
  const bare = name.replace(/-/g, "");
  return RESERVED_NAMES.includes(name) || RESERVED_NAMES.includes(bare);
}

/**
 * What a valid name of this length costs, in USDC.
 *
 * Exported for the price list a client shows before anything is typed. It does
 * not validate; `checkName` is the gate.
 */
export function priceForLength(length: number): number {
  return NAME_PRICE_USDC_BY_LENGTH.get(length) ?? LONG_NAME_PRICE_USDC;
}

/**
 * The one gate. Normalizes, validates, and prices in a single pass so no
 * caller can price a name it has not validated, or validate one spelling and
 * store another.
 */
export function checkName(candidate: string): NameCheck {
  const name = normalizeName(candidate);

  if (name.length === 0) return { ok: false, reason: "empty" };
  if (name.length < MIN_SELLABLE_LENGTH) return { ok: false, reason: "too_short" };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, reason: "too_long" };
  if (!/^[a-z0-9-]+$/.test(name)) return { ok: false, reason: "bad_charset" };
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return { ok: false, reason: "bad_hyphen" };
  }
  if (isReserved(name)) return { ok: false, reason: "reserved" };

  return { ok: true, name, priceUsdc: priceForLength(name.length) };
}

/**
 * What one Masquerade figure costs, in USDC.
 *
 * Flat across all twenty. The figures differ in traits, not in price: the
 * collection's claim is that token #N proves you were the Nth buyer, and a
 * per-figure price would make it a claim about the art instead.
 */
export const NFT_PRICE_USDC = 5;

/** How many figures exist. There will not be a twenty-first. */
export const NFT_COLLECTION_SIZE = 20;
