import { WraithError } from "../errors";
import {
  callUntypedGet,
  useWraithQuery,
  type GetQuery,
  type GetResponse,
  type WraithQueryOptions,
} from "../internal";
import { queryKeys } from "../queryKeys";

/**
 * Dual-identifier lookup parameters required for every `/ngn` order or bill
 * status read. Both `customerRef` and `orderId` are mandatory — there is no
 * single-identifier shortcut.
 */
export interface NgnOrderLookupParams {
  /** Stable customer reference derived from the wallet address. */
  customerRef: string;
  /** Provider/order identifier returned when the order or bill was created. */
  orderId: string;
  /** Optional network override (`testnet` or `mainnet`). */
  network?: "testnet" | "mainnet";
}

/** Response shape for `GET /ngn/onramp/orders/{orderId}`. */
export interface NgnOnrampOrderStatusResponse {
  orderId?: string;
  id?: string;
  status: string;
  providerStatus?: string;
  amountStableCoin?: number;
  amountNgn?: number;
  rate?: number;
  coin?: string;
  walletAddress?: string;
  source?: "live" | "cache";
  [key: string]: unknown;
}

/** Response shape for `GET /ngn/bills/{orderId}`. */
export interface NgnBillStatusResponse {
  id?: string;
  orderId?: string;
  status: string;
  providerStatus?: string;
  billCategory?: string;
  provider?: string;
  amountNgn?: number;
  amountStableCoin?: number;
  rate?: number;
  coin?: string;
  source?: "live" | "cache";
  [key: string]: unknown;
}

function assertDualIdentifierLookup(params: NgnOrderLookupParams): void {
  if (
    !params ||
    typeof params.customerRef !== "string" ||
    !params.customerRef.trim() ||
    typeof params.orderId !== "string" ||
    !params.orderId.trim()
  ) {
    throw new WraithError(400, {
      error: "Both customerRef and orderId are required for NGN order/bill lookups",
      code: "invalid_request",
    });
  }
}

/** Check whether a customer reference is verified (`GET /ngn/customers/status`). */
export function useNgnCustomerStatus(
  query: GetQuery<"/ngn/customers/status">,
  options?: WraithQueryOptions<GetResponse<"/ngn/customers/status">>,
) {
  return useWraithQuery<GetResponse<"/ngn/customers/status">>(
    queryKeys.ngn.customerStatus(query),
    (client) =>
      client.GET("/ngn/customers/status", {
        params: { query },
      }),
    options,
  );
}

/** List mobile data bundles for NGN bill payment (`GET /ngn/bills/data-bundles`). */
export function useNgnDataBundles(
  query?: GetQuery<"/ngn/bills/data-bundles">,
  options?: WraithQueryOptions<GetResponse<"/ngn/bills/data-bundles">>,
) {
  return useWraithQuery<GetResponse<"/ngn/bills/data-bundles">>(
    queryKeys.ngn.dataBundles(query),
    (client) =>
      client.GET("/ngn/bills/data-bundles", {
        params: { query },
      }),
    options,
  );
}

/**
 * Poll the status of an NGN onramp order (`GET /ngn/onramp/orders/{orderId}`).
 * Requires both `customerRef` and `orderId`.
 */
export function useNgnOnrampOrderStatus(
  params: NgnOrderLookupParams,
  options?: WraithQueryOptions<NgnOnrampOrderStatusResponse>,
) {
  const { customerRef, orderId, network } = params;
  return useWraithQuery<NgnOnrampOrderStatusResponse>(
    queryKeys.ngn.onrampOrderStatus(customerRef, orderId, network),
    async (client) => {
      assertDualIdentifierLookup(params);
      return callUntypedGet<NgnOnrampOrderStatusResponse>(
        client,
        "/ngn/onramp/orders/{orderId}",
        {
          params: {
            path: { orderId },
            query: {
              customerRef,
              ...(network ? { network } : {}),
            },
          },
        },
      );
    },
    options,
  );
}

/**
 * Poll the status of an NGN bill payment (`GET /ngn/bills/{orderId}`).
 * Requires both `customerRef` and `orderId`.
 */
export function useNgnBillStatus(
  params: NgnOrderLookupParams,
  options?: WraithQueryOptions<NgnBillStatusResponse>,
) {
  const { customerRef, orderId, network } = params;
  return useWraithQuery<NgnBillStatusResponse>(
    queryKeys.ngn.billStatus(customerRef, orderId, network),
    async (client) => {
      assertDualIdentifierLookup(params);
      return callUntypedGet<NgnBillStatusResponse>(
        client,
        "/ngn/bills/{orderId}",
        {
          params: {
            path: { orderId },
            query: {
              customerRef,
              ...(network ? { network } : {}),
            },
          },
        },
      );
    },
    options,
  );
}
