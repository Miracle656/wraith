import {
  callUntypedGet,
  useWraithQuery,
  type WraithQueryOptions,
} from "../internal";
import { queryKeys } from "../queryKeys";

/** Supported OHLC candle bucket intervals (`GET /candles/{bucket}/{contractId}`). */
export type CandleBucket = "1m" | "1h" | "1d";

/** Query parameters accepted by `GET /candles/{bucket}/{contractId}`. */
export interface CandlesQuery {
  limit?: number;
  offset?: number;
}

/** Single OHLC candle entry returned by `GET /candles/{bucket}/{contractId}`. */
export interface Candle {
  timeBucket: string;
  contractId: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  txCount: number;
}

/** Response body returned by `GET /candles/{bucket}/{contractId}`. */
export interface CandlesResponse {
  bucket: CandleBucket;
  contractId: string;
  candles: Candle[];
}

/**
 * Fetch OHLC candles for a token contract (`GET /candles/{bucket}/{contractId}`).
 * Available on single-network deployments where `OHLC_REFRESH_INTERVAL_MS` is configured.
 */
export function useCandles(
  bucket: CandleBucket,
  contractId: string,
  query?: CandlesQuery,
  options?: WraithQueryOptions<CandlesResponse>,
) {
  return useWraithQuery<CandlesResponse>(
    queryKeys.candles.series(bucket, contractId, query),
    (client) =>
      callUntypedGet<CandlesResponse>(client, "/candles/{bucket}/{contractId}", {
        params: {
          path: { bucket, contractId },
          ...(query ? { query: query as Record<string, unknown> } : {}),
        },
      }),
    options,
  );
}
