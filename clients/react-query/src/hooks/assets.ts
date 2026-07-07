import { queryKeys } from "../queryKeys";
import {
  useWraithQuery,
  type GetQuery,
  type GetResponse,
  type WraithQueryOptions,
} from "../internal";

/** The most-active assets leaderboard (`GET /assets/popular`). */
export function usePopularAssets(
  query?: GetQuery<"/assets/popular">,
  options?: WraithQueryOptions<GetResponse<"/assets/popular">>,
) {
  return useWraithQuery<GetResponse<"/assets/popular">>(
    queryKeys.assets.popular(query),
    (client) => client.GET("/assets/popular", { params: { query } }),
    options,
  );
}
