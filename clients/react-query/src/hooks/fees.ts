import {
  useWraithQuery,
  type GetQuery,
  type GetResponse,
  type WraithQueryOptions,
} from "../internal";
import { queryKeys } from "../queryKeys";

/** Parameters for the operator fee ledger report (`GET /fees/report`). */
export interface FeeReportParams {
  /** Bearer token matching `VEIL_FEE_REPORT_TOKEN` when not already set on the client. */
  token?: string;
  /** Optional UTC date range (`from`, `to`). */
  query?: GetQuery<"/fees/report">;
}

/** Fetch the platform fee schedule (`GET /fees`). */
export function useFees(
  query?: GetQuery<"/fees">,
  options?: WraithQueryOptions<GetResponse<"/fees">>,
) {
  return useWraithQuery<GetResponse<"/fees">>(
    queryKeys.fees.schedule(query),
    (client) =>
      client.GET("/fees", {
        params: { query },
      }),
    options,
  );
}

/**
 * Fetch the operator fee ledger report (`GET /fees/report`).
 * Sends `Authorization: Bearer <token>` when `params.token` is provided.
 */
export function useFeeReport(
  params?: FeeReportParams,
  options?: WraithQueryOptions<GetResponse<"/fees/report">>,
) {
  const query = params?.query;
  const token = params?.token;
  return useWraithQuery<GetResponse<"/fees/report">>(
    queryKeys.fees.report(query),
    (client) =>
      client.GET("/fees/report", {
        params: { query },
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      }),
    options,
  );
}
