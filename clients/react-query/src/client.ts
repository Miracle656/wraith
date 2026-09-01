import createFetchClient, { type Client } from "openapi-fetch";
import type { paths } from "./schema";

/** Options for {@link createWraithClient}. */
export interface WraithClientOptions {
  /** Base URL of the Wraith API, e.g. `https://wraith.example.com`. */
  baseUrl: string;
  /** Extra headers sent with every request (e.g. an API key). */
  headers?: Record<string, string>;
  /** Custom fetch implementation (defaults to the global `fetch`). */
  fetch?: typeof fetch;
}

/** A typed openapi-fetch client bound to the Wraith OpenAPI spec. */
export type WraithClient = Client<paths>;

/**
 * Create a typed Wraith API client. The returned client is consumed by the
 * React Query hooks via {@link WraithClientProvider}; you rarely call its
 * methods directly.
 */
export function createWraithClient(options: WraithClientOptions): WraithClient {
  const { baseUrl, headers, fetch: fetchImpl } = options;
  return createFetchClient<paths>({
    baseUrl: baseUrl.replace(/\/$/, ""),
    headers,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
