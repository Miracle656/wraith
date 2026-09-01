/**
 * Stable React Query key factory. Importing this lets callers invalidate or
 * prefetch the same keys the hooks use, e.g.
 * `queryClient.invalidateQueries({ queryKey: queryKeys.transfers.all })`.
 */
export const queryKeys = {
  transfers: {
    all: ["wraith", "transfers"] as const,
    incoming: (address: string, query?: unknown) =>
      ["wraith", "transfers", "incoming", address, query] as const,
    outgoing: (address: string, query?: unknown) =>
      ["wraith", "transfers", "outgoing", address, query] as const,
    forAddress: (address: string, query?: unknown) =>
      ["wraith", "transfers", "address", address, query] as const,
    byTx: (txHash: string) =>
      ["wraith", "transfers", "tx", txHash] as const,
  },
  accounts: {
    all: ["wraith", "accounts"] as const,
    summary: (address: string) =>
      ["wraith", "accounts", "summary", address] as const,
    transfers: (address: string, query?: unknown) =>
      ["wraith", "accounts", "transfers", address, query] as const,
  },
  assets: {
    all: ["wraith", "assets"] as const,
    popular: (query?: unknown) =>
      ["wraith", "assets", "popular", query] as const,
  },
  nfts: {
    all: ["wraith", "nfts"] as const,
    transfers: (query?: unknown) =>
      ["wraith", "nfts", "transfers", query] as const,
  },
  webhooks: {
    all: ["wraith", "webhooks"] as const,
    list: () => ["wraith", "webhooks", "list"] as const,
    deliveries: (id: number, query?: unknown) =>
      ["wraith", "webhooks", "deliveries", id, query] as const,
  },
  hostFn: {
    all: ["wraith", "host-fn"] as const,
    logs: (contractId: string, query?: unknown) =>
      ["wraith", "host-fn", contractId, query] as const,
  },
  status: () => ["wraith", "status"] as const,
} as const;
