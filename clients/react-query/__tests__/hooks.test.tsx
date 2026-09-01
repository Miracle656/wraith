import { describe, it, expect } from "vitest";
import { type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createWraithClient,
  WraithClientProvider,
  WraithError,
  useIncomingTransfers,
  usePopularAssets,
  useWebhooks,
  useStatus,
} from "../src";

const BASE = "https://wraith.test";

interface Captured {
  urls: string[];
}

/**
 * Build a fetch stub that records request URLs and replies with `body`/`status`
 * for any request (the tests assert on a single call each).
 */
function stubFetch(
  body: unknown,
  status = 200,
): { fetch: typeof fetch; captured: Captured } {
  const captured: Captured = { urls: [] };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
    captured.urls.push(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, captured };
}

function makeWrapper(fetchImpl: typeof fetch) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const client = createWraithClient({ baseUrl: BASE, fetch: fetchImpl });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <WraithClientProvider client={client}>{children}</WraithClientProvider>
      </QueryClientProvider>
    );
  };
}

describe("@wraith/react-query hooks", () => {
  it("useIncomingTransfers fetches the right path and parses the page", async () => {
    const page = {
      total: 1,
      limit: 50,
      offset: 0,
      nextCursor: null,
      transfers: [
        {
          id: 1,
          contractId: "CSAC",
          eventType: "transfer",
          fromAddress: "GFROM",
          toAddress: "GABC",
          amount: "10000000",
          ledger: 100,
          ledgerClosedAt: "2026-01-01T00:00:00Z",
          txHash: "deadbeef",
          eventId: "evt-1",
          displayAmount: "1.0000000",
        },
      ],
    };
    const { fetch, captured } = stubFetch(page);
    const { result } = renderHook(
      () => useIncomingTransfers("GABC", { limit: 50 }),
      { wrapper: makeWrapper(fetch) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.transfers?.[0]?.contractId).toBe("CSAC");
    expect(result.current.data?.transfers?.[0]?.displayAmount).toBe("1.0000000");
    const url = new URL(captured.urls[0]);
    expect(url.pathname).toBe("/transfers/incoming/GABC");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("usePopularAssets serializes query params", async () => {
    const body = {
      window: "24h",
      by: "volume",
      total: 1,
      limit: 10,
      offset: 0,
      assets: [
        { contractId: "CABC", transferCount: 5, volume: "100", displayVolume: "1.0" },
      ],
    };
    const { fetch, captured } = stubFetch(body);
    const { result } = renderHook(
      () => usePopularAssets({ window: "24h", by: "volume" }),
      { wrapper: makeWrapper(fetch) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.assets?.[0]?.contractId).toBe("CABC");
    const url = new URL(captured.urls[0]);
    expect(url.pathname).toBe("/assets/popular");
    expect(url.searchParams.get("window")).toBe("24h");
    expect(url.searchParams.get("by")).toBe("volume");
  });

  it("useWebhooks fetches the collection with no params", async () => {
    const body = {
      subscriptions: [
        {
          id: 1,
          url: "https://example.com/hook",
          filter: null,
          active: true,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const { fetch, captured } = stubFetch(body);
    const { result } = renderHook(() => useWebhooks(), {
      wrapper: makeWrapper(fetch),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.subscriptions?.[0]?.id).toBe(1);
    expect(new URL(captured.urls[0]).pathname).toBe("/webhooks");
  });

  it("surfaces a non-2xx response as a WraithError", async () => {
    const { fetch } = stubFetch({ error: "boom" }, 500);
    const { result } = renderHook(() => useStatus(), {
      wrapper: makeWrapper(fetch),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(WraithError);
    expect(result.current.error?.status).toBe(500);
    expect(result.current.error?.message).toContain("boom");
  });
});
