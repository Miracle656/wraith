/**
 * The order status as sent to wallet apps.
 *
 * Installed Veil APKs decide an order is finished only when its status
 * contains "settled", "disbursed", "failed" or "timeout". The provider also
 * ends orders as "refunded" (and can expire, cancel or reverse them), which
 * those apps do not recognise -- so a refunded order was shown as still waiting
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

/**
 * The same translation for the **bills** rail, which speaks a second dialect.
 *
 * The onramp and offramp screens end on "settled", "disbursed", "failed" or
 * "timeout" (above). The airtime/electricity screens do not: they end on
 * `/complete|success|delivered/` for a win and `/fail|refund|revers|cancel/`
 * for a loss. Linq ends a vend as "settled" or "disbursed" — a word the bills
 * screen has no case for — so a top-up that was delivered and paid for left the
 * app on "Waiting for the top-up…" forever, with no reference on screen and the
 * poll's only record of its own failure a `console.warn` nobody can read.
 *
 * So a successful ending is sent carrying both dialects: the provider's own
 * word first, then "(completed)", which the bills screen recognises. The loss
 * cases already work — `statusForClients` appends "(failed)" for a refund,
 * cancel or reversal, and "fail" is in the bills screen's vocabulary too.
 *
 * Installed APKs cannot be rebuilt on demand, which is why this lives on the
 * server. `src/api/ngn.ts` also returns the raw provider value as
 * `providerStatus`, so nothing is lost for a newer client or a human reading it.
 */
export function billStatusForClients(status: string): string {
  const s = status.toLowerCase();
  const alreadyUnderstood = /complete|success|deliver/.test(s);
  if (!alreadyUnderstood && /settled|disbursed/.test(s)) {
    return `${status} (completed)`;
  }
  return statusForClients(status);
}
