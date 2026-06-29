import { queryKeys } from "../queryKeys";
import {
  useWraithQuery,
  type GetQuery,
  type GetResponse,
  type WraithQueryOptions,
} from "../internal";

/** NFT (token-id) transfers (`GET /nfts/transfers`). */
export function useNftTransfers(
  query?: GetQuery<"/nfts/transfers">,
  options?: WraithQueryOptions<GetResponse<"/nfts/transfers">>,
) {
  return useWraithQuery<GetResponse<"/nfts/transfers">>(
    queryKeys.nfts.transfers(query),
    (client) => client.GET("/nfts/transfers", { params: { query } }),
    options,
  );
}
