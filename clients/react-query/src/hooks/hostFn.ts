import { queryKeys } from "../queryKeys";
import {
  useWraithQuery,
  type GetQuery,
  type GetResponse,
  type WraithQueryOptions,
} from "../internal";

/** Host-function invocation logs for a contract (`GET /host-fn/{contractId}`). */
export function useHostFunctionLogs(
  contractId: string,
  query?: GetQuery<"/host-fn/{contractId}">,
  options?: WraithQueryOptions<GetResponse<"/host-fn/{contractId}">>,
) {
  return useWraithQuery<GetResponse<"/host-fn/{contractId}">>(
    queryKeys.hostFn.logs(contractId, query),
    (client) =>
      client.GET("/host-fn/{contractId}", {
        params: { path: { contractId }, query },
      }),
    options,
  );
}
