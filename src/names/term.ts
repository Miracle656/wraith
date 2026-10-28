/**
 * The life of a Veil name: when it expires, when it stops resolving, and when
 * somebody else may take it.
 *
 * A name is rented by the year, not owned. That is a deliberate choice and it
 * buys back abandoned names, but it also creates the one failure this module
 * exists to contain: a name that lapses and is then taken by somebody else
 * keeps working in every contact list that already has it, and starts paying a
 * stranger. Permanent ownership could not do that. Rental can, so the lifecycle
 * is built around making a lapsed name fail loudly rather than quietly change
 * hands.
 *
 * Four states, in order:
 *
 *   ACTIVE    — resolves. A renewal reminder goes out 30 days before the end.
 *   RECOVERY  — expired. Does NOT resolve. Only the previous holder may
 *               re-register, for 90 days.
 *   OPEN      — does not resolve, and anyone may register it.
 *   (claimed)  — someone registers it; the serial increments.
 *
 * The RECOVERY window is not a grace period in the usual sense: the name is
 * already dead to senders the moment it expires, which is what was asked for.
 * What the window buys is the two things a hard cutoff cannot. Someone who
 * forgot a 3 USDC renewal gets their name back instead of losing it to whoever
 * was watching, and every stale contact fails for a full quarter before a
 * repoint is even possible.
 */

/**
 * A registration year, in milliseconds — 365 days, flat.
 *
 * Deliberately not a calendar year. A term has to be computed the same way by
 * the contract, the server and the client, and "one year from 29 February" has
 * no single answer. A fixed 365 days is reproducible everywhere and a reader
 * can check the arithmetic by hand.
 */
export const REGISTRATION_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** The shortest term that can be bought. */
export const MIN_TERM_YEARS = 1;

/**
 * The longest term that can be bought, in one purchase.
 *
 * Five is a judgement call, not a constraint from anywhere. It is long enough
 * that nobody renewing in good faith is inconvenienced, and short enough that
 * a price set today is not locked in for a decade of a namespace whose value
 * nobody can predict yet. A holder who wants longer renews again.
 */
export const MAX_TERM_YEARS = 5;

/** How long before expiry the holder is first told. */
export const RENEWAL_REMINDER_DAYS = 30;

/**
 * How long after expiry only the previous holder may re-register.
 *
 * Ninety days does double duty — see the module comment. It is the single
 * most important number here for not losing anyone's money.
 */
export const RECOVERY_WINDOW_DAYS = 90;

export const RECOVERY_WINDOW_MS = RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const RENEWAL_REMINDER_MS = RENEWAL_REMINDER_DAYS * 24 * 60 * 60 * 1000;

/** Where a name is in its life. */
export const NAME_STATES = ["active", "recovery", "open"] as const;
export type NameState = (typeof NAME_STATES)[number];

/** A term in years, validated. */
export type TermCheck = { ok: true; years: number } | { ok: false; reason: "bad_term" };

/**
 * Validate a requested term.
 *
 * Whole years only, inside the bounds. A fractional term would make the expiry
 * arithmetic unverifiable by eye for no benefit anyone asked for.
 */
export function checkTerm(years: number): TermCheck {
  if (!Number.isInteger(years) || years < MIN_TERM_YEARS || years > MAX_TERM_YEARS) {
    return { ok: false, reason: "bad_term" };
  }
  return { ok: true, years };
}

/** When a registration starting at `startMs` for `years` runs out. */
export function expiresAt(startMs: number, years: number): number {
  return startMs + years * REGISTRATION_YEAR_MS;
}

/** When a name that expired at `expiryMs` becomes available to anyone. */
export function opensAt(expiryMs: number): number {
  return expiryMs + RECOVERY_WINDOW_MS;
}

/** Which state a name with this expiry is in, as of `nowMs`. */
export function stateAt(expiryMs: number, nowMs: number): NameState {
  if (nowMs < expiryMs) return "active";
  if (nowMs < opensAt(expiryMs)) return "recovery";
  return "open";
}

/**
 * Whether federation should answer for this name at all.
 *
 * The one rule a sender depends on: an expired name does not resolve, from the
 * instant it expires. No grace, no last-minute leniency. A name that still
 * resolves after its term is a name whose holder believes it is working.
 */
export function resolves(expiryMs: number, nowMs: number): boolean {
  return stateAt(expiryMs, nowMs) === "active";
}

/**
 * Whether `claimant` may register this name now.
 *
 * `previousHolder` is the address the name last belonged to, or null for a
 * name nobody has ever held. During RECOVERY only that address qualifies.
 */
export function canRegister(
  expiryMs: number | null,
  previousHolder: string | null,
  claimant: string,
  nowMs: number,
): boolean {
  if (expiryMs === null) return true;
  const state = stateAt(expiryMs, nowMs);
  if (state === "active") return false;
  if (state === "open") return true;
  return previousHolder !== null && previousHolder === claimant;
}

/**
 * Whether a renewal reminder is due.
 *
 * True from 30 days out until the moment of expiry. Callers are expected to
 * remember what they have already sent; this answers "is it time", not "has it
 * been sent", because a reminder that re-sends every hour for thirty days is
 * worse than none.
 */
export function reminderDue(expiryMs: number, nowMs: number): boolean {
  return nowMs >= expiryMs - RENEWAL_REMINDER_MS && nowMs < expiryMs;
}

/**
 * Anyone may pay to renew anyone's name.
 *
 * There is no access check here on purpose, and this function exists to say so
 * where someone looking for one will find it. Renewal only ever extends a name
 * for its current holder — it cannot move it, re-point it or take it — so the
 * worst a stranger can do is pay your bill. Refusing that would mean a name
 * lapsing because its holder lost their phone in the wrong week, while a friend
 * who would gladly have covered it was turned away.
 */
export const RENEWAL_IS_OPEN_TO_ANYONE = true;

/**
 * A new expiry after renewing by `years`.
 *
 * Extends from the existing expiry, not from now, so renewing early never
 * costs the holder the time they already paid for. A name in RECOVERY renews
 * from the moment of recovery instead — its unused time is gone, and dating
 * the new term from a past expiry would sell back time already spent.
 */
export function renewedExpiry(expiryMs: number, years: number, nowMs: number): number {
  const base = Math.max(expiryMs, nowMs);
  return base + years * REGISTRATION_YEAR_MS;
}
