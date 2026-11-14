import {
  useWraithQuery,
  type GetQuery,
  type GetResponse,
  type WraithQueryOptions,
} from "../internal";
import { queryKeys } from "../queryKeys";

/** Fuzzy search across accounts, assets, and contracts (`GET /search`). */
export function useSearch(
  query: GetQuery<"/search">,
  options?: WraithQueryOptions<GetResponse<"/search">>,
) {
  return useWraithQuery<GetResponse<"/search">>(
    queryKeys.search.results(query),
    (client) =>
      client.GET("/search", {
        params: { query },
      }),
    options,
  );
}
