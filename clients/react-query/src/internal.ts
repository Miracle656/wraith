import {
  useQuery,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { WraithClient } from "./client";
import { useWraithClient } from "./context";
import { WraithError } from "./errors";
import type { paths } from "./schema";

/** The `200` `application/json` body returned by a GET on path `P`. */
export type GetResponse<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { "application/json": infer R } } } };
}
  ? R
  : never;

/** The query-string parameters accepted by a GET on path `P`. */
export type GetQuery<P extends keyof paths> = paths[P] extends {
  get: { parameters: { query?: infer Q } };
}
  ? Q
  : never;

/** Options forwarded to React Query, minus the bits the hooks own. */
export type WraithQueryOptions<TData> = Omit<
  UseQueryOptions<TData, WraithError, TData, QueryKey>,
  "queryKey" | "queryFn"
>;

interface FetchResult<TData> {
  data?: TData;
  error?: unknown;
  response: Response;
}

/**
 * Shared wrapper turning an openapi-fetch call into a typed `useQuery`. Non-2xx
 * responses (or transport errors surfaced by openapi-fetch) become a thrown
 * {@link WraithError} so React Query exposes them via `error`.
 */
export function useWraithQuery<TData>(
  queryKey: QueryKey,
  fetcher: (client: WraithClient) => Promise<FetchResult<TData>>,
  options?: WraithQueryOptions<TData>,
): UseQueryResult<TData, WraithError> {
  const client = useWraithClient();
  return useQuery<TData, WraithError>({
    queryKey,
    queryFn: async () => {
      const { data, error, response } = await fetcher(client);
      if (!response.ok || error !== undefined) {
        throw new WraithError(response.status, error ?? data);
      }
      return data as TData;
    },
    ...options,
  });
}
