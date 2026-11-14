import { describe, it, expect } from "vitest";
import { type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createWraithClient,
  WraithClientProvider,
  WraithError,
  useOfframpAvailability,
  useOfframpRate,
  useOfframpTrustline,
  useVerifyOfframpBank,
  useCreateOfframpOrder,
  useOfframpOrderStatus,
  useFees,
  useFeeReport,
  useSearch,
  useCandles,
  useNgnCustomerStatus,
  useNgnDataBundles,
  useNgnOnrampOrderStatus,
  useNgnBillStatus,
  type NgnOrderLookupParams,
} from "../src";

const BASE = "https://wraith.test";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(
  body: unknown,
  status = 200,
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let parsedBody: unknown = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const text = await req.clone().text();
      if (text) {
        try {
          parsedBody = JSON.parse(text);
        } catch {
          parsedBody = text;
        }
      }
    }
    requests.push({
      url: req.url,
      method: req.method,
      headers,
      body: parsedBody,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function makeWrapper(fetchImpl: typeof fetch) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
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

describe("@wraith/react-query money rails, fees, candles, and search hooks", () => {
  it("useOfframpAvailability, useOfframpRate, and useOfframpTrustline call their GET endpoints", async () => {
    const availStub = stubFetch({ available: true });
    const { result: availRes } = renderHook(() => useOfframpAvailability(), {
      wrapper: makeWrapper(availStub.fetch),
    });
    await waitFor(() => expect(availRes.current.isSuccess).toBe(true));
    expect(availRes.current.data).toEqual({ available: true });
    expect(new URL(availStub.requests[0].url).pathname).toBe("/offramp/availability");

    const rateStub = stubFetch({ coin: "usdc", rate: 1620.5, indicative: true });
    const { result: rateRes } = renderHook(
      () => useOfframpRate({ coin: "usdc" }),
      { wrapper: makeWrapper(rateStub.fetch) },
    );
    await waitFor(() => expect(rateRes.current.isSuccess).toBe(true));
    expect(rateRes.current.data?.rate).toBe(1620.5);
    const rateUrl = new URL(rateStub.requests[0].url);
    expect(rateUrl.pathname).toBe("/offramp/rate");
    expect(rateUrl.searchParams.get("coin")).toBe("usdc");

    const trustStub = stubFetch({
      address: "GABC123",
      valid: true,
      trustsUSDC: true,
    });
    const { result: trustRes } = renderHook(
      () => useOfframpTrustline({ address: "GABC123" }),
      { wrapper: makeWrapper(trustStub.fetch) },
    );
    await waitFor(() => expect(trustRes.current.isSuccess).toBe(true));
    expect(trustRes.current.data?.trustsUSDC).toBe(true);
    const trustUrl = new URL(trustStub.requests[0].url);
    expect(trustUrl.pathname).toBe("/offramp/trustline");
    expect(trustUrl.searchParams.get("address")).toBe("GABC123");
  });

  it("useVerifyOfframpBank and useCreateOfframpOrder use useMutation and POST JSON payloads", async () => {
    const verifyStub = stubFetch({
      accountName: "ADA LOVELACE",
      bankName: "GTBank",
      accountNumber: "0123456789",
      bankCode: "058",
    });
    const { result: verifyRes } = renderHook(() => useVerifyOfframpBank(), {
      wrapper: makeWrapper(verifyStub.fetch),
    });

    await act(async () => {
      await verifyRes.current.mutateAsync({
        bankCode: "058",
        accountNumber: "0123456789",
      });
    });

    expect(verifyStub.requests).toHaveLength(1);
    expect(verifyStub.requests[0].method).toBe("POST");
    expect(new URL(verifyStub.requests[0].url).pathname).toBe("/offramp/verify-bank");
    expect(verifyStub.requests[0].body).toEqual({
      bankCode: "058",
      accountNumber: "0123456789",
    });

    const createStub = stubFetch(
      {
        id: "ord_cashout_1",
        accessToken: "tok",
        walletAddress: "GDEPOSIT",
        chain: "stellar",
        coin: "USDC",
        amountStableCoin: 25,
        amountNGN: 40500,
        rate: 1620,
        status: "waiting_for_deposit",
      },
      201,
    );
    const { result: createRes } = renderHook(() => useCreateOfframpOrder(), {
      wrapper: makeWrapper(createStub.fetch),
    });

    let createdOrder: Awaited<ReturnType<typeof createRes.current.mutateAsync>> | undefined;
    await act(async () => {
      createdOrder = await createRes.current.mutateAsync({
        amountStableCoin: 25,
        bankAccount: "0123456789",
        bankCode: "058",
        bankName: "GTBank",
        accountName: "ADA LOVELACE",
        refundAddress: "GREFUND",
        walletAddress: "GWALLET",
        idempotencyKey: "idem-1",
      });
    });

    expect(createStub.requests[0].method).toBe("POST");
    expect(new URL(createStub.requests[0].url).pathname).toBe("/offramp/orders");
    expect(createdOrder?.id).toBe("ord_cashout_1");
    expect(createdOrder?.accessToken).toBe("tok");
  });

  it("useOfframpOrderStatus sends the bearer accessToken header and rejects when missing", async () => {
    const statusStub = stubFetch({
      id: "ord_cashout_1",
      status: "completed",
      providerStatus: "settled",
      amountStableCoin: 25,
      amountNGN: 40500,
      depositAddress: "GDEPOSIT",
      rate: 1620,
      createdAt: "2026-01-01T00:00:00Z",
      source: "live",
    });
    const { result } = renderHook(
      () =>
        useOfframpOrderStatus({
          orderId: "ord_cashout_1",
          accessToken: "tok",
        }),
      { wrapper: makeWrapper(statusStub.fetch) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.status).toBe("completed");
    expect(new URL(statusStub.requests[0].url).pathname).toBe(
      "/offramp/orders/ord_cashout_1",
    );
    expect(statusStub.requests[0].headers["authorization"]).toBe(
      "Bearer tok",
    );

    // Missing accessToken rejects with a 401 WraithError without hitting the network
    const emptyStub = stubFetch({});
    const { result: missingTokenRes } = renderHook(
      () => useOfframpOrderStatus({ orderId: "ord_cashout_1", accessToken: "  " }),
      { wrapper: makeWrapper(emptyStub.fetch) },
    );
    await waitFor(() => expect(missingTokenRes.current.isError).toBe(true));
    expect(missingTokenRes.current.error).toBeInstanceOf(WraithError);
    expect(missingTokenRes.current.error?.status).toBe(401);
    expect(emptyStub.requests).toHaveLength(0);
  });

  it("useFees and useFeeReport query /fees and /fees/report with optional bearer token", async () => {
    const feesStub = stubFetch({
      enabled: true,
      fees: {
        USDC: {
          amount: "0.10",
          asset: { code: "USDC", issuer: "GISSUER" },
          destination: "GFEE",
          percent: "0.5",
        },
      },
    });
    const { result: feesRes } = renderHook(
      () => useFees({ amount: "20" }),
      { wrapper: makeWrapper(feesStub.fetch) },
    );
    await waitFor(() => expect(feesRes.current.isSuccess).toBe(true));
    expect(feesRes.current.data?.enabled).toBe(true);
    const feesUrl = new URL(feesStub.requests[0].url);
    expect(feesUrl.pathname).toBe("/fees");
    expect(feesUrl.searchParams.get("amount")).toBe("20");

    const reportStub = stubFetch({
      network: "testnet",
      from: "2026-01-01",
      to: "2026-01-02",
      alarmPercent: 5,
      days: [],
      policies: {},
    });
    const { result: reportRes } = renderHook(
      () =>
        useFeeReport({
          token: "tok",
          query: { from: "2026-01-01", to: "2026-01-02" },
        }),
      { wrapper: makeWrapper(reportStub.fetch) },
    );
    await waitFor(() => expect(reportRes.current.isSuccess).toBe(true));
    const reportUrl = new URL(reportStub.requests[0].url);
    expect(reportUrl.pathname).toBe("/fees/report");
    expect(reportUrl.searchParams.get("from")).toBe("2026-01-01");
    expect(reportStub.requests[0].headers["authorization"]).toBe(
      "Bearer tok",
    );
  });

  it("useSearch and useCandles serialize path and query parameters", async () => {
    const searchStub = stubFetch({
      query: "USDC",
      count: 1,
      results: [{ type: "asset", value: "CUSDC", isSac: true }],
    });
    const { result: searchRes } = renderHook(
      () => useSearch({ q: "USDC", network: "testnet" }),
      { wrapper: makeWrapper(searchStub.fetch) },
    );
    await waitFor(() => expect(searchRes.current.isSuccess).toBe(true));
    expect(searchRes.current.data?.results[0]?.value).toBe("CUSDC");
    const searchUrl = new URL(searchStub.requests[0].url);
    expect(searchUrl.pathname).toBe("/search");
    expect(searchUrl.searchParams.get("q")).toBe("USDC");

    const candlesStub = stubFetch({
      bucket: "1h",
      contractId: "CCONTRACT123",
      candles: [
        {
          timeBucket: "2026-01-01T00:00:00Z",
          contractId: "CCONTRACT123",
          open: "1.0",
          high: "1.2",
          low: "0.9",
          close: "1.1",
          volume: "5000",
          txCount: 12,
        },
      ],
    });
    const { result: candlesRes } = renderHook(
      () => useCandles("1h", "CCONTRACT123", { limit: 24, offset: 0 }),
      { wrapper: makeWrapper(candlesStub.fetch) },
    );
    await waitFor(() => expect(candlesRes.current.isSuccess).toBe(true));
    expect(candlesRes.current.data?.candles[0]?.txCount).toBe(12);
    const candlesUrl = new URL(candlesStub.requests[0].url);
    expect(candlesUrl.pathname).toBe("/candles/1h/CCONTRACT123");
    expect(candlesUrl.searchParams.get("limit")).toBe("24");
  });

  it("useNgnCustomerStatus and useNgnDataBundles fetch the documented /ngn endpoints", async () => {
    const custStub = stubFetch({
      customerRef: "cust_ref_1",
      verified: true,
      status: "verified",
    });
    const { result: custRes } = renderHook(
      () => useNgnCustomerStatus({ customerRef: "cust_ref_1" }),
      { wrapper: makeWrapper(custStub.fetch) },
    );
    await waitFor(() => expect(custRes.current.isSuccess).toBe(true));
    expect(custRes.current.data?.verified).toBe(true);
    const custUrl = new URL(custStub.requests[0].url);
    expect(custUrl.pathname).toBe("/ngn/customers/status");
    expect(custUrl.searchParams.get("customerRef")).toBe("cust_ref_1");

    const bundlesStub = stubFetch({
      bundles: [
        {
          code: "mtn-1gb",
          provider: "MTN",
          name: "1GB Daily",
          allowance: "1GB",
          validity: "1 day",
          priceNgn: 350,
        },
      ],
    });
    const { result: bundlesRes } = renderHook(
      () => useNgnDataBundles({ provider: "MTN" }),
      { wrapper: makeWrapper(bundlesStub.fetch) },
    );
    await waitFor(() => expect(bundlesRes.current.isSuccess).toBe(true));
    expect(bundlesRes.current.data?.bundles[0]?.code).toBe("mtn-1gb");
    const bundlesUrl = new URL(bundlesStub.requests[0].url);
    expect(bundlesUrl.pathname).toBe("/ngn/bills/data-bundles");
    expect(bundlesUrl.searchParams.get("provider")).toBe("MTN");
  });

  it("useNgnOnrampOrderStatus and useNgnBillStatus require both customerRef and orderId", async () => {
    // Compile-time check: omitting either identifier is a type error
    // @ts-expect-error — orderId alone is forbidden
    const _missingCustomerRef: NgnOrderLookupParams = { orderId: "ord_1" };
    // @ts-expect-error — customerRef alone is forbidden
    const _missingOrderId: NgnOrderLookupParams = { customerRef: "cust_1" };
    void _missingCustomerRef;
    void _missingOrderId;

    const onrampStub = stubFetch({
      orderId: "ord_onramp_1",
      status: "completed",
      amountNgn: 15000,
    });
    const { result: onrampRes } = renderHook(
      () =>
        useNgnOnrampOrderStatus({
          customerRef: "cust_ref_1",
          orderId: "ord_onramp_1",
        }),
      { wrapper: makeWrapper(onrampStub.fetch) },
    );
    await waitFor(() => expect(onrampRes.current.isSuccess).toBe(true));
    const onrampUrl = new URL(onrampStub.requests[0].url);
    expect(onrampUrl.pathname).toBe("/ngn/onramp/orders/ord_onramp_1");
    expect(onrampUrl.searchParams.get("customerRef")).toBe("cust_ref_1");

    const billStub = stubFetch({
      id: "ord_bill_1",
      status: "completed",
      providerStatus: "settled",
    });
    const { result: billRes } = renderHook(
      () =>
        useNgnBillStatus({
          customerRef: "cust_ref_1",
          orderId: "ord_bill_1",
        }),
      { wrapper: makeWrapper(billStub.fetch) },
    );
    await waitFor(() => expect(billRes.current.isSuccess).toBe(true));
    const billUrl = new URL(billStub.requests[0].url);
    expect(billUrl.pathname).toBe("/ngn/bills/ord_bill_1");
    expect(billUrl.searchParams.get("customerRef")).toBe("cust_ref_1");

    // Runtime check: blank customerRef or orderId rejects immediately with 400 WraithError
    const emptyStub = stubFetch({});
    const { result: badLookupRes } = renderHook(
      () => useNgnBillStatus({ customerRef: "", orderId: "ord_bill_1" }),
      { wrapper: makeWrapper(emptyStub.fetch) },
    );
    await waitFor(() => expect(badLookupRes.current.isError).toBe(true));
    expect(badLookupRes.current.error).toBeInstanceOf(WraithError);
    expect(badLookupRes.current.error?.status).toBe(400);
    expect(emptyStub.requests).toHaveLength(0);
  });
});
