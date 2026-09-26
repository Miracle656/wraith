/**
 * The order status as sent to wallet apps.
 *
 * Installed Veil APKs decide an order is finished only when its status
 * contains "settled", "disbursed", "failed" or "timeout". The provider also
 * ends orders as "refunded" (and can expire, cancel or reverse them), which
 * those apps do not recognise — so a refunded order was shown as still waiting
 * for payment, with a Pay button pointing at a deposit address that no longer
 * exists. A user got stuck on exactly that screen.
 *
 * Apps cannot be rebuilt on demand, so the fix lives here: an ending the old
 * apps do not know is sent with a word they do ("failed" or "timeout"), which
 * moves them to the finished screen with its "any USDC that arrived is
 * refunded" note. The provider's own word stays first, so newer apps and humans
 * reading it lose nothing, and the raw value is also returned as
 * `providerStatus`.
 */
export function statusForClients(status: string): string {
  const s = status.toLowerCase();
  const legacyTerminal = ["settled", "disbursed", "failed", "timeout"].some((w) => s.includes(w));
  if (legacyTerminal) return status;
  if (s.includes("expire")) return `${status} (timeout)`;
  if (s.includes("refund") || s.includes("cancel") || s.includes("revers")) {
    return `${status} (failed)`;
  }
  return status;
}
