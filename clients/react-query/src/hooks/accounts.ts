import { queryKeys } from "../queryKeys";
import {
  useWraithQuery,
  type GetQuery,
  type GetResponse,
  type WraithQueryOptions,
} from "../internal";

/** An account's per-asset holdings (`GET /accounts/{address}/summary`). */
export function useAccountSummary(
  address: string,
  options?: WraithQueryOptions<GetResponse<"/accounts/{address}/summary">>,
) {
  return useWraithQuery<GetResponse<"/accounts/{address}/summary">>(
    queryKeys.accounts.summary(address),
    (client) =>
      client.GET("/accounts/{address}/summary", {
        params: { path: { address } },
      }),
    options,
  );
}

/** An account's transfers (`GET /accounts/{address}/transfers`). */
export function useAccountTransfers(
  address: string,
  query?: GetQuery<"/accounts/{address}/transfers">,
  options?: WraithQueryOptions<GetResponse<"/accounts/{address}/transfers">>,
) {
  return useWraithQuery<GetResponse<"/accounts/{address}/transfers">>(
    queryKeys.accounts.transfers(address, query),
    (client) =>
      client.GET("/accounts/{address}/transfers", {
        params: { path: { address }, query },
      }),
    options,
  );
}
