import { queryKeys } from "../queryKeys";
import {
  useWraithQuery,
  type GetQuery,
  type GetResponse,
  type WraithQueryOptions,
} from "../internal";

/** List webhook subscriptions (`GET /webhooks`). */
export function useWebhooks(
  options?: WraithQueryOptions<GetResponse<"/webhooks">>,
) {
  return useWraithQuery<GetResponse<"/webhooks">>(
    queryKeys.webhooks.list(),
    (client) => client.GET("/webhooks"),
    options,
  );
}

/** A webhook's delivery log (`GET /webhooks/{id}/deliveries`). */
export function useWebhookDeliveries(
  id: number,
  query?: GetQuery<"/webhooks/{id}/deliveries">,
  options?: WraithQueryOptions<GetResponse<"/webhooks/{id}/deliveries">>,
) {
  return useWraithQuery<GetResponse<"/webhooks/{id}/deliveries">>(
    queryKeys.webhooks.deliveries(id, query),
    (client) =>
      client.GET("/webhooks/{id}/deliveries", {
        params: { path: { id }, query },
      }),
    options,
  );
}
