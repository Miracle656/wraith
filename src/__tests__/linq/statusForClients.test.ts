import { statusForClients } from "../../linq/statusForClients";

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
