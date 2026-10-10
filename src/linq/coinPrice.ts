/**
 * What one unit of a settlement coin is worth in US dollars.
 *
 * ## Why this exists
 *
 * Linq's `/onramprate` returns one number: **naira per US dollar**. It takes no
 * coin, and — measured on 2026-10-10 — silently ignores a `coin` query
 * parameter rather than rejecting it, returning the dollar rate either way.
 *
 * Both naira screens divided naira by that number and called the result an
 * amount of coin. For USDC that is right by coincidence, because a USDC is a
 * dollar. For XLM it was wrong by the price of XLM: a ₦1,000 purchase bought
 * 0.69 XLM instead of 3.6, and a ₦500 airtime top-up was paid for with 6 cents
 * of XLM. Real money moved both ways before anyone noticed, because the number
 * on screen was plausible.
 *
 * So the conversion lives here, server-side, once — not in each client, where
 * it was wrong twice.
 *
 * ## Where the price comes from
 *
 * Mainnet Horizon's XLM/USDC order book: the mid of the best bid and ask. It
 * is the venue the user's own wallet trades on, needs no extra credential, and
 * is a price we can point at afterwards rather than one an opaque API asserted.
 *
 * ## It refuses rather than guesses
 *
 * Every failure throws. There is deliberately no fallback value and no "use
 * the last good price", because the failure mode this module exists to prevent
 * is precisely a plausible-looking wrong number being used to move money. A
 * naira screen with no rate is an inconvenience; a naira screen with a rate
 * that is five times wrong is a loss.
 */

import { LinqError } from "./client";

/** Circle's USDC on mainnet, identified by home domain rather than code. */
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const HORIZON_URL = process.env.HORIZON_URL_MAINNET?.trim() || "https://horizon.stellar.org";

const TIMEOUT_MS = 8_000;

/**
 * Prices outside this band are treated as a broken book, not as news.
 *
 * XLM has never been near either end. The point is not to predict the price,
 * it is that a malformed or manipulated order book must not be able to produce
 * an order, and an absurd number is the shape that mistake takes.
 */
const MIN_XLM_USD = 0.001;
const MAX_XLM_USD = 100;

/**
 * Quotes are cached briefly so a screen that asks twice does not pay for two
 * round trips, and so a burst of users cannot turn into a burst at Horizon.
 * Short enough that a quote is never materially stale.
 */
const CACHE_MS = 15_000;

let cached: { usd: number; at: number } | null = null;

interface OrderBookLevel {
  price?: string;
}

async function fetchXlmUsd(): Promise<number> {
  const url =
    `${HORIZON_URL}/order_book?selling_asset_type=native` +
    `&buying_asset_type=credit_alphanum4&buying_asset_code=USDC` +
    `&buying_asset_issuer=${USDC_ISSUER}&limit=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let body: { bids?: OrderBookLevel[]; asks?: OrderBookLevel[] };
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new LinqError("Could not price XLM right now", 502);
    body = (await res.json()) as typeof body;
  } catch (err) {
    if (err instanceof LinqError) throw err;
    throw new LinqError("Could not price XLM right now", 502);
  } finally {
    clearTimeout(timer);
  }

  const bid = Number(body.bids?.[0]?.price);
  const ask = Number(body.asks?.[0]?.price);

  // One side empty means nobody is quoting, which is not a price. A crossed
  // book (bid above ask) means the data is wrong, whatever it says.
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid > ask) {
    throw new LinqError("Could not price XLM right now", 502);
  }

  const mid = (bid + ask) / 2;
  if (mid < MIN_XLM_USD || mid > MAX_XLM_USD) {
    throw new LinqError("Could not price XLM right now", 502);
  }
  return mid;
}

/** US dollars per unit of `coin`. Throws rather than returning a guess. */
export async function usdPerCoin(coin: "xlm" | "usdc"): Promise<number> {
  // Not fetched: a USDC is a dollar by construction, and going to an order
  // book for that would add a failure mode to a fact.
  if (coin === "usdc") return 1;

  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.usd;

  const usd = await fetchXlmUsd();
  cached = { usd, at: now };
  return usd;
}

/** Test seam. Production never clears this; the TTL does. */
export function __clearCoinPriceCache(): void {
  cached = null;
}
