import { WraithError } from "../errors";
import {
  useWraithMutation,
  useWraithQuery,
  type GetQuery,
  type GetResponse,
  type PostBody,
  type PostResponse,
  type WraithMutationOptions,
  type WraithQueryOptions,
} from "../internal";
import { queryKeys } from "../queryKeys";

/** Response payload from `POST /offramp/orders`, including the per-order bearer token. */
export type CreateOfframpOrderResponse = PostResponse<"/offramp/orders"> & {
  /** Per-order HMAC bearer token required to poll `GET /offramp/orders/{orderId}`. */
  accessToken?: string;
};

/** Parameters required to poll a cash-out order's status (`GET /offramp/orders/{orderId}`). */
export interface OfframpOrderStatusParams {
  /** Order identifier returned by `POST /offramp/orders`. */
  orderId: string;
  /** Per-order bearer token (`accessToken`) returned by `POST /offramp/orders`. */
  accessToken: string;
}

/** Check whether cash-out is enabled on this deployment (`GET /offramp/availability`). */
export function useOfframpAvailability(
  options?: WraithQueryOptions<GetResponse<"/offramp/availability">>,
) {
  return useWraithQuery<GetResponse<"/offramp/availability">>(
    queryKeys.offramp.availability(),
    (client) => client.GET("/offramp/availability"),
    options,
  );
}

/** Fetch the indicative naira-per-coin rate (`GET /offramp/rate`). */
export function useOfframpRate(
  query?: GetQuery<"/offramp/rate">,
  options?: WraithQueryOptions<GetResponse<"/offramp/rate">>,
) {
  return useWraithQuery<GetResponse<"/offramp/rate">>(
    queryKeys.offramp.rate(query),
    (client) =>
      client.GET("/offramp/rate", {
        params: { query },
      }),
    options,
  );
}

/** Check whether a classic refund address holds a USDC trustline (`GET /offramp/trustline`). */
export function useOfframpTrustline(
  query: GetQuery<"/offramp/trustline">,
  options?: WraithQueryOptions<GetResponse<"/offramp/trustline">>,
) {
  return useWraithQuery<GetResponse<"/offramp/trustline">>(
    queryKeys.offramp.trustline(query),
    (client) =>
      client.GET("/offramp/trustline", {
        params: { query },
      }),
    options,
  );
}

/** Verify a bank account before creating a cash-out order (`POST /offramp/verify-bank`). */
export function useVerifyOfframpBank(
  options?: WraithMutationOptions<
    PostResponse<"/offramp/verify-bank">,
    PostBody<"/offramp/verify-bank">
  >,
) {
  return useWraithMutation<
    PostResponse<"/offramp/verify-bank">,
    PostBody<"/offramp/verify-bank">
  >(
    (client, body) =>
      client.POST("/offramp/verify-bank", {
        body,
      }),
    options,
  );
}

/** Create a cash-out order (`POST /offramp/orders`). */
export function useCreateOfframpOrder(
  options?: WraithMutationOptions<
    CreateOfframpOrderResponse,
    PostBody<"/offramp/orders">
  >,
) {
  return useWraithMutation<
    CreateOfframpOrderResponse,
    PostBody<"/offramp/orders">
  >(
    (client, body) =>
      client.POST("/offramp/orders", {
        body,
      }),
    options,
  );
}

/**
 * Poll the status of a cash-out order (`GET /offramp/orders/{orderId}`).
 * Sends `Authorization: Bearer <accessToken>` using the token returned by
 * `POST /offramp/orders`.
 */
export function useOfframpOrderStatus(
  params: OfframpOrderStatusParams,
  options?: WraithQueryOptions<GetResponse<"/offramp/orders/{orderId}">>,
) {
  const { orderId, accessToken } = params;
  return useWraithQuery<GetResponse<"/offramp/orders/{orderId}">>(
    queryKeys.offramp.orderStatus(orderId),
    async (client) => {
      if (!orderId?.trim() || !accessToken?.trim()) {
        throw new WraithError(401, {
          error: "orderId and accessToken are required to read offramp order status",
          code: "unauthorized",
        });
      }
      return client.GET("/offramp/orders/{orderId}", {
        params: { path: { orderId } },
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
    },
    options,
  );
}
