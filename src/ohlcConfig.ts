import { currentNetwork, enabledNetworks } from "./network";

/** Shared opt-in for the legacy single-network candles API and refresh worker. */
export function getOhlcRefreshIntervalMs(): number | undefined {
  if (process.env.SKIP_INDEXER === "true") return undefined;
  const networks = enabledNetworks();
  if (networks.length !== 1 || networks[0] !== currentNetwork()) return undefined;

  const raw = process.env.OHLC_REFRESH_INTERVAL_MS?.trim() ?? "";
  const interval = Number(raw);
  // Node clamps delays above 2^31-1 to 1ms, which would overload the database.
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(interval)
      || interval <= 0 || interval > 2_147_483_647) return undefined;
  return interval;
}
