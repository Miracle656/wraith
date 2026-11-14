export { createWraithClient } from "./client";
export type { WraithClient, WraithClientOptions } from "./client";
export {
  WraithClientProvider,
  useWraithClient,
} from "./context";
export type { WraithClientProviderProps } from "./context";
export { WraithError } from "./errors";
export { queryKeys } from "./queryKeys";
export type {
  GetQuery,
  GetResponse,
  PostBody,
  PostResponse,
  WraithMutationOptions,
  WraithQueryOptions,
} from "./internal";

// Hooks — one module per resource.
export {
  useIncomingTransfers,
  useOutgoingTransfers,
  useAddressTransfers,
  useTransactionTransfers,
} from "./hooks/transfers";
export { useAccountSummary, useAccountTransfers } from "./hooks/accounts";
export { usePopularAssets } from "./hooks/assets";
export { useNftTransfers } from "./hooks/nfts";
export { useWebhooks, useWebhookDeliveries } from "./hooks/webhooks";
export { useHostFunctionLogs } from "./hooks/hostFn";
export { useStatus } from "./hooks/status";
export {
  useOfframpAvailability,
  useOfframpRate,
  useOfframpTrustline,
  useVerifyOfframpBank,
  useCreateOfframpOrder,
  useOfframpOrderStatus,
} from "./hooks/offramp";
export type {
  CreateOfframpOrderResponse,
  OfframpOrderStatusParams,
} from "./hooks/offramp";
export { useFees, useFeeReport } from "./hooks/fees";
export type { FeeReportParams } from "./hooks/fees";
export { useSearch } from "./hooks/search";
export { useCandles } from "./hooks/candles";
export type {
  Candle,
  CandleBucket,
  CandlesQuery,
  CandlesResponse,
} from "./hooks/candles";
export {
  useNgnCustomerStatus,
  useNgnDataBundles,
  useNgnOnrampOrderStatus,
  useNgnBillStatus,
} from "./hooks/ngn";
export type {
  NgnOrderLookupParams,
  NgnOnrampOrderStatusResponse,
  NgnBillStatusResponse,
} from "./hooks/ngn";

// The generated OpenAPI types, re-exported for advanced use.
export type { paths, components } from "./schema";
