import {
  useMutation,
  useQuery,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
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

/** The JSON request body accepted by a POST on path `P`. */
export type PostBody<P extends keyof paths> = paths[P] extends {
  post: {
    requestBody: { content: { "application/json": infer B } };
  };
}
  ? B
  : never;

/** The `200` or `201` `application/json` body returned by a POST on path `P`. */
export type PostResponse<P extends keyof paths> = paths[P] extends {
  post: { responses: infer R };
}
  ? R extends { 200: { content: { "application/json": infer R200 } } }
    ? R200
    : R extends { 201: { content: { "application/json": infer R201 } } }
      ? R201
      : never
  : never;

/** Options forwarded to React Query's `useQuery`, minus the bits the hooks own. */
export type WraithQueryOptions<TData> = Omit<
  UseQueryOptions<TData, WraithError, TData, QueryKey>,
  "queryKey" | "queryFn"
>;

/** Options forwarded to React Query's `useMutation`, minus `mutationFn`. */
export type WraithMutationOptions<TData, TVariables> = Omit<
  UseMutationOptions<TData, WraithError, TVariables>,
  "mutationFn"
>;

export interface FetchResult<TData> {
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

/**
 * Shared wrapper turning an openapi-fetch POST/DELETE call into a typed
 * `useMutation`. Non-2xx responses reject with a {@link WraithError}.
 */
export function useWraithMutation<TData, TVariables>(
  mutator: (client: WraithClient, variables: TVariables) => Promise<FetchResult<TData>>,
  options?: WraithMutationOptions<TData, TVariables>,
): UseMutationResult<TData, WraithError, TVariables> {
  const client = useWraithClient();
  return useMutation<TData, WraithError, TVariables>({
    mutationFn: async (variables) => {
      const { data, error, response } = await mutator(client, variables);
      if (!response.ok || error !== undefined) {
        throw new WraithError(response.status, error ?? data);
      }
      return data as TData;
    },
    ...options,
  });
}

/**
 * Invoke a GET path that is conditionally registered or pending OpenAPI schema
 * generation while still routing through the configured `openapi-fetch` client.
 */
export function callUntypedGet<TData>(
  client: WraithClient,
  pathTemplate: string,
  init?: {
    params?: {
      path?: Record<string, string | number>;
      query?: Record<string, unknown>;
    };
    headers?: Record<string, string>;
  },
): Promise<FetchResult<TData>> {
  const untyped = client as unknown as {
    GET: (url: string, options?: unknown) => Promise<FetchResult<TData>>;
  };
  return untyped.GET(pathTemplate, init);
}
