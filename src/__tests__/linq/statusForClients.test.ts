import { statusForClients, billStatusForClients } from "../../linq/statusForClients";

// What installed Veil apps treat as a finished order.
const legacyIsTerminal = (status: string) =>
  ["settled", "disbursed", "failed", "timeout"].some((w) => status.toLowerCase().includes(w));

describe("statusForClients", () => {
  it.each(["refunded", "Refunded", "cancelled", "reversed"])(
    "lets installed apps finish a %s order instead of offering to pay it",
    (status) => {
      const sent = statusForClients(status);
      expect(legacyIsTerminal(sent)).toBe(true);
      expect(sent.startsWith(status)).toBe(true);
    },
  );

  it("sends an expired order as a timeout", () => {
    expect(statusForClients("expired")).toBe("expired (timeout)");
  });

  it.each([
    "processing: wallet worker on it..",
    "initiated",
    "processing: in bank queue",
    "disbursed",
    "settled",
    "failed",
  ])("leaves %s untouched", (status) => {
    expect(statusForClients(status)).toBe(status);
  });
});

describe("billStatusForClients", () => {
  // The bills screen in installed APKs ends on /complete|success|delivered/.
  // Linq ends a vend as "settled" or "disbursed", which that screen has no case
  // for — so a delivered, paid-for top-up sat on "Waiting for the top-up…"
  // forever. The provider's word is kept first; "(completed)" is appended so
  // the screen can recognise the ending.
  it.each(["settled", "SETTLED", "disbursed", "payment_settled"])(
    "carries a word the bills screen knows for %s",
    (status) => {
      const out = billStatusForClients(status);
      expect(out.startsWith(status)).toBe(true);
      expect(/complete|success|delivered/i.test(out)).toBe(true);
    },
  );

  it("leaves a status the screen already understands alone", () => {
    expect(billStatusForClients("completed")).toBe("completed");
    expect(billStatusForClients("successful")).toBe("successful");
    expect(billStatusForClients("delivered")).toBe("delivered");
  });

  it("does not end an order that is still moving", () => {
    for (const status of ["pending", "processing", "settlement_pending", "awaiting_payment"]) {
      const out = billStatusForClients(status);
      expect(/complete|success|delivered/i.test(out)).toBe(false);
      expect(/fail|refund|revers|cancel/i.test(out)).toBe(false);
    }
  });

  it("still sends a loss in a word the bills screen knows", () => {
    for (const status of ["refunded", "cancelled", "reversed", "expired", "failed"]) {
      const out = billStatusForClients(status);
      expect(/fail|refund|revers|cancel|timeout/i.test(out)).toBe(true);
      expect(/complete|success|delivered/i.test(out)).toBe(false);
    }
  });
});
