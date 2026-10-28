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
 * What a name costs, in USDC, by how many characters it has.
 *
 * `1-5 => 3, 6-10 => 5, 11+ => 2`.
 *
 * Note that this is deliberately NOT monotonic, and a reader who expects a
 * registry's usual shape will think it is a bug: the dearest band is the
 * middle one, not the shortest. It prices demand rather than scarcity. Real
 * first names land in 6-10 characters, so that band is where nearly all of
 * the asking will be, and it is priced accordingly; very short names are
 * cheaper and very long ones cheapest.
 *
 * Do not "correct" this into a descending curve without being told to. The
 * tests pin the inversion on purpose.
 *
 * Each band is an inclusive upper bound, checked in order.
 */
export const NAME_PRICE_BANDS: readonly { readonly maxLength: number; readonly priceUsdc: number }[] = [
  { maxLength: 5, priceUsdc: 3 },
  { maxLength: 10, priceUsdc: 5 },
];

/** What a name longer than the last band costs — 11 characters and up. */
export const LONG_NAME_PRICE_USDC = 2;

/** The first length that falls into the flat long-name price. */
export const LONG_NAME_MIN_LENGTH = 11;

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
 *
 * 20 is the number the Veil Names design states to the user in so many words —
 * "3 to 20 characters" — so it is the number a client will have already
 * promised by the time anything reaches this module.
 */
export const MAX_NAME_LENGTH = 20;

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
  "no_reply",
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
   * Contains a character outside `[a-z0-9_]` after normalization. This is the
   * homoglyph rule: a Cyrillic "а" is not an "a", and a name that reads as
   * somebody else's is a payment redirect.
   */
  "bad_charset",
  /** An underscore at the start or end, or two in a row. */
  "bad_separator",
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
 *
 * Underscore is the only separator, per the design's stated rule. Allowing a
 * hyphen as well would make `jack_ng` and `jack-ng` two different names that
 * no one can tell apart when read aloud — the same confusable problem the
 * charset rule exists to prevent, reintroduced by a convenience.
 */
export function normalizeName(candidate: string): string {
  return candidate.trim().toLowerCase();
}

/**
 * True if `name` is reserved, ignoring separators used to sneak past the list.
 *
 * The design promises the user that "names that could be used to pose as Veil
 * or its team are reserved", and `s_u_p_p_o_r_t` poses exactly as well as
 * `support` does in a screen that renders it.
 */
export function isReserved(name: string): boolean {
  const bare = name.replace(/_/g, "");
  return RESERVED_NAMES.includes(name) || RESERVED_NAMES.includes(bare);
}

/**
 * What a valid name of this length costs, in USDC.
 *
 * Exported for the price list a client shows before anything is typed. It does
 * not validate; `checkName` is the gate.
 */
export function priceForLength(length: number): number {
  for (const band of NAME_PRICE_BANDS) {
    if (length <= band.maxLength) return band.priceUsdc;
  }
  return LONG_NAME_PRICE_USDC;
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
  if (!/^[a-z0-9_]+$/.test(name)) return { ok: false, reason: "bad_charset" };
  if (name.startsWith("_") || name.endsWith("_") || name.includes("__")) {
    return { ok: false, reason: "bad_separator" };
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
