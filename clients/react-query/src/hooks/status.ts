import { queryKeys } from "../queryKeys";
import {
  useWraithQuery,
  type GetResponse,
  type WraithQueryOptions,
} from "../internal";

/** Indexer status / lag (`GET /status`). */
export function useStatus(
  options?: WraithQueryOptions<GetResponse<"/status">>,
) {
  return useWraithQuery<GetResponse<"/status">>(
    queryKeys.status(),
    (client) => client.GET("/status"),
    options,
  );
}
