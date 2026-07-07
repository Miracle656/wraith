import { queryKeys } from "../queryKeys";
import {
  useWraithQuery,
  type GetQuery,
  type GetResponse,
  type WraithQueryOptions,
} from "../internal";

/** Transfers received by an address (`GET /transfers/incoming/{address}`). */
export function useIncomingTransfers(
  address: string,
  query?: GetQuery<"/transfers/incoming/{address}">,
  options?: WraithQueryOptions<GetResponse<"/transfers/incoming/{address}">>,
) {
  return useWraithQuery<GetResponse<"/transfers/incoming/{address}">>(
    queryKeys.transfers.incoming(address, query),
    (client) =>
      client.GET("/transfers/incoming/{address}", {
        params: { path: { address }, query },
      }),
    options,
  );
}

/** Transfers sent by an address (`GET /transfers/outgoing/{address}`). */
export function useOutgoingTransfers(
  address: string,
  query?: GetQuery<"/transfers/outgoing/{address}">,
  options?: WraithQueryOptions<GetResponse<"/transfers/outgoing/{address}">>,
) {
  return useWraithQuery<GetResponse<"/transfers/outgoing/{address}">>(
    queryKeys.transfers.outgoing(address, query),
    (client) =>
      client.GET("/transfers/outgoing/{address}", {
        params: { path: { address }, query },
      }),
    options,
  );
}

/** All transfers touching an address (`GET /transfers/address/{address}`). */
export function useAddressTransfers(
  address: string,
  query?: GetQuery<"/transfers/address/{address}">,
  options?: WraithQueryOptions<GetResponse<"/transfers/address/{address}">>,
) {
  return useWraithQuery<GetResponse<"/transfers/address/{address}">>(
    queryKeys.transfers.forAddress(address, query),
    (client) =>
      client.GET("/transfers/address/{address}", {
        params: { path: { address }, query },
      }),
    options,
  );
}

/** Transfers in a single transaction (`GET /transfers/tx/{txHash}`). */
export function useTransactionTransfers(
  txHash: string,
  options?: WraithQueryOptions<GetResponse<"/transfers/tx/{txHash}">>,
) {
  return useWraithQuery<GetResponse<"/transfers/tx/{txHash}">>(
    queryKeys.transfers.byTx(txHash),
    (client) =>
      client.GET("/transfers/tx/{txHash}", {
        params: { path: { txHash } },
      }),
    options,
  );
}
