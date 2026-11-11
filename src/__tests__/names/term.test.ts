/**
 * The life of a name.
 *
 * The assertions that matter most are the ones around a lapsed name. Rental
 * creates a hazard permanent ownership did not: a name that expires and is
 * taken by somebody else still works in every contact list that has it, and
 * pays a stranger. These pin the window that prevents it.
 */
import {
  MAX_TERM_YEARS,
  MIN_TERM_YEARS,
  RECOVERY_WINDOW_MS,
  REGISTRATION_YEAR_MS,
  RENEWAL_IS_OPEN_TO_ANYONE,
  RENEWAL_REMINDER_MS,
  canRegister,
  checkTerm,
  expiresAt,
  opensAt,
  reminderDue,
  renewedExpiry,
  resolves,
  stateAt,
} from "../../names/term";

const T0 = 1_800_000_000_000;
const HOLDER = "CABCH3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL7PCJ7";
const STRANGER = "CDUS5SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4MXQHK";
const DAY = 24 * 60 * 60 * 1000;

describe("terms", () => {
  it("accepts one through five whole years", () => {
    for (let y = MIN_TERM_YEARS; y <= MAX_TERM_YEARS; y++) {
      expect(checkTerm(y)).toEqual({ ok: true, years: y });
    }
  });

  it("refuses zero, negative, fractional and over-long terms", () => {
    for (const bad of [0, -1, 1.5, MAX_TERM_YEARS + 1, NaN, Infinity]) {
      expect(checkTerm(bad)).toEqual({ ok: false, reason: "bad_term" });
    }
  });

  it("uses a flat 365-day year so three parties compute one expiry", () => {
    // Not a calendar year: "one year from 29 February" has no single answer,
    // and the contract, the server and the client must agree exactly.
    expect(REGISTRATION_YEAR_MS).toBe(365 * DAY);
    expect(expiresAt(T0, 1)).toBe(T0 + 365 * DAY);
    expect(expiresAt(T0, 3)).toBe(T0 + 3 * 365 * DAY);
  });
});

describe("resolution stops the instant a name expires", () => {
  const expiry = expiresAt(T0, 1);

  it("resolves right up to the last millisecond", () => {
    expect(resolves(expiry, expiry - 1)).toBe(true);
    expect(stateAt(expiry, expiry - 1)).toBe("active");
  });

  it("stops at the moment of expiry, with no grace", () => {
    // A name that still resolves after its term is a name whose holder
    // believes it is working. There is deliberately no leniency here.
    expect(resolves(expiry, expiry)).toBe(false);
    expect(stateAt(expiry, expiry)).toBe("recovery");
  });

  it("never resolves again, in recovery or once open", () => {
    expect(resolves(expiry, expiry + DAY)).toBe(false);
    expect(resolves(expiry, opensAt(expiry))).toBe(false);
    expect(resolves(expiry, opensAt(expiry) + 365 * DAY)).toBe(false);
  });
});

describe("the recovery window — the repoint guard", () => {
  const expiry = expiresAt(T0, 1);

  it("lasts 90 days from expiry", () => {
    expect(RECOVERY_WINDOW_MS).toBe(90 * DAY);
    expect(opensAt(expiry)).toBe(expiry + 90 * DAY);
    expect(stateAt(expiry, expiry + 89 * DAY)).toBe("recovery");
    expect(stateAt(expiry, expiry + 90 * DAY)).toBe("open");
  });

  it("lets only the previous holder take the name back during it", () => {
    const during = expiry + 30 * DAY;
    expect(canRegister(expiry, HOLDER, HOLDER, during)).toBe(true);
    expect(canRegister(expiry, HOLDER, STRANGER, during)).toBe(false);
  });

  it("stops a stranger repointing a name for a full quarter", () => {
    // The whole point. Every stale contact fails for 90 days before anyone
    // else can possibly be behind that name.
    for (const offset of [0, DAY, 45 * DAY, 89 * DAY]) {
      expect(canRegister(expiry, HOLDER, STRANGER, expiry + offset)).toBe(false);
    }
    expect(canRegister(expiry, HOLDER, STRANGER, expiry + 90 * DAY)).toBe(true);
  });

  it("refuses everyone, holder included, while the name is still active", () => {
    expect(canRegister(expiry, HOLDER, HOLDER, T0 + DAY)).toBe(false);
    expect(canRegister(expiry, HOLDER, STRANGER, T0 + DAY)).toBe(false);
  });

  it("lets anyone register a name nobody has ever held", () => {
    expect(canRegister(null, null, STRANGER, T0)).toBe(true);
  });

  it("opens a never-renewed lapsed name to anyone after the window", () => {
    expect(canRegister(expiry, null, STRANGER, opensAt(expiry))).toBe(true);
  });
});

describe("renewal reminders", () => {
  const expiry = expiresAt(T0, 1);

  it("is due from 30 days out", () => {
    expect(RENEWAL_REMINDER_MS).toBe(30 * DAY);
    expect(reminderDue(expiry, expiry - 31 * DAY)).toBe(false);
    expect(reminderDue(expiry, expiry - 30 * DAY)).toBe(true);
    expect(reminderDue(expiry, expiry - DAY)).toBe(true);
  });

  it("is not due once the name has already expired", () => {
    // After expiry the message is not "renew soon", it is "your name stopped
    // working" — a different notice this flag must not stand in for.
    expect(reminderDue(expiry, expiry)).toBe(false);
    expect(reminderDue(expiry, expiry + DAY)).toBe(false);
  });
});

describe("renewing", () => {
  const expiry = expiresAt(T0, 1);

  it("extends from the existing expiry, so renewing early costs nothing", () => {
    const early = expiry - 60 * DAY;
    expect(renewedExpiry(expiry, 1, early)).toBe(expiry + 365 * DAY);
  });

  it("extends from now when the name has already lapsed", () => {
    // Dating the new term from a past expiry would sell back time already gone.
    const inRecovery = expiry + 30 * DAY;
    expect(renewedExpiry(expiry, 1, inRecovery)).toBe(inRecovery + 365 * DAY);
  });

  it("is open to anyone, because a stranger can only pay your bill", () => {
    // Renewal extends a name for its current holder and cannot move or
    // re-point it, so there is nothing to protect against.
    expect(RENEWAL_IS_OPEN_TO_ANYONE).toBe(true);
  });
});
