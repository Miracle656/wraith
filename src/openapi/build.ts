import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { getOhlcRefreshIntervalMs } from "../ohlcConfig";
import {
  addressPathSchema,
  booleanOkResponseSchema,
  candlesParamsSchema,
  candlesQuerySchema,
  candlesResponseSchema,
  errorResponseSchema,
  healthzResponseSchema,
  hostFnQuerySchema,
  hostFnLogsResponseSchema,
  hostFnParamsSchema,
  nftOwnerParamsSchema,
  nftOwnerResponseSchema,
  nftTransfersQuerySchema,
  nftTransfersResponseSchema,
  popularAssetsQuerySchema,
  popularAssetsResponseSchema,
  readyzQuerySchema,
  readyzResponseSchema,
  searchQuerySchema,
  searchResponseSchema,
  statusQuerySchema,
  statusResponseSchema,
  summaryQuerySchema,
  summaryResponseSchema,
  transferListResponseSchema,
  transferQuerySchema,
  txHashParamsSchema,
  txTransfersResponseSchema,
  webhookCreateBodySchema,
  webhookCreatedResponseSchema,
  webhookDeleteParamsSchema,
  webhookDeliveriesParamsSchema,
  webhookDeliveriesQuerySchema,
  webhookDeliveriesResponseSchema,
  webhookSubscriptionsResponseSchema,
  accountBalanceResponseSchema,
  tokensQuerySchema,
  tokensResponseSchema,
  transferExportQuerySchema,
  binaryExportResponseSchema,
  linqWebhookAckResponseSchema,
  offrampRateResponseSchema,
  offrampVerifyBankBodySchema,
  offrampVerifiedBankSchema,
  offrampTrustlineQuerySchema,
  offrampTrustlineResponseSchema,
  offrampOrderBodySchema,
  offrampOrderResponseSchema,
  offrampOrderParamsSchema,
  offrampOrderStatusResponseSchema,
  offrampErrorResponseSchema,
} from "./schemas";

const registry = new OpenAPIRegistry();

const commonErrorResponses = {
  400: { description: "Bad Request", content: { "application/json": { schema: errorResponseSchema } } },
  404: { description: "Not Found", content: { "application/json": { schema: errorResponseSchema } } },
  500: { description: "Internal Server Error", content: { "application/json": { schema: errorResponseSchema } } },
};

const transferQueryOnlySchema = transferQuerySchema.omit({ address: true });
const summaryQueryOnlySchema = summaryQuerySchema.omit({ address: true });

const transferListResponses = {
  200: { description: "OK", content: { "application/json": { schema: transferListResponseSchema } } },
  ...commonErrorResponses,
};

registry.registerPath({
  method: "get",
  path: "/healthz",
  summary: "Liveness probe",
  responses: {
    200: { description: "OK", content: { "application/json": { schema: healthzResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/readyz",
  summary: "Readiness probe",
  request: { query: readyzQuerySchema },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: readyzResponseSchema } } },
    503: { description: "Service Unavailable", content: { "application/json": { schema: readyzResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/metrics",
  summary: "Prometheus metrics",
  description:
    "Indexer and process metrics in Prometheus text exposition format. Served from " +
    "in-process counters only — no database or RPC call — so it keeps answering while " +
    "the subsystems it reports on are down.",
  responses: {
    200: {
      description: "Prometheus text exposition format",
      content: { "text/plain": { schema: { type: "string" as const } } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/status",
  summary: "Indexer status",
  request: { query: statusQuerySchema },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: statusResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/transfers/incoming/{address}",
  summary: "Incoming transfers",
  request: {
    params: addressPathSchema,
    query: transferQueryOnlySchema,
  },
  responses: transferListResponses,
});

registry.registerPath({
  method: "get",
  path: "/transfers/outgoing/{address}",
  summary: "Outgoing transfers",
  request: {
    params: addressPathSchema,
    query: transferQueryOnlySchema,
  },
  responses: transferListResponses,
});

registry.registerPath({
  method: "get",
  path: "/transfers/address/{address}",
  summary: "All transfers for address",
  request: {
    params: addressPathSchema,
    query: transferQueryOnlySchema,
  },
  responses: transferListResponses,
});

registry.registerPath({
  method: "get",
  path: "/transfers/address/{address}/export.csv",
  summary: "Export transfers to CSV",
  request: {
    params: addressPathSchema,
    query: transferQueryOnlySchema.omit({ limit: true, offset: true, cursor: true, $filter: true, $select: true }),
  },
  responses: {
    200: {
      description: "CSV export",
      content: {
        "text/csv": {
          schema: { type: "string", format: "binary" },
        },
      },
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/transfers/tx/{txHash}",
  summary: "Transfers by transaction",
  request: { params: txHashParamsSchema },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: txTransfersResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/summary/{address}",
  summary: "Token summary",
  request: {
    params: addressPathSchema,
    query: summaryQueryOnlySchema,
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: summaryResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/accounts/{address}/summary",
  summary: "Token summary",
  request: {
    params: addressPathSchema,
    query: summaryQueryOnlySchema,
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: summaryResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/accounts/{address}/balance",
  summary: "Derived token balances",
  description:
    "Per-token balance for an address, derived by summing indexed transfers — not " +
    "a read from chain. Excludes any history before the indexer's start ledger, so " +
    "an address that held a token before then reads low.",
  request: {
    params: addressPathSchema,
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: accountBalanceResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/accounts/{address}/transfers",
  summary: "Account transfers",
  request: {
    params: addressPathSchema,
    query: transferQueryOnlySchema,
  },
  responses: transferListResponses,
});

registry.registerPath({
  method: "post",
  path: "/webhooks",
  summary: "Create a webhook subscription",
  request: {
    body: {
      content: {
        "application/json": {
          schema: webhookCreateBodySchema,
        },
      },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: webhookCreatedResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/webhooks",
  summary: "List webhook subscriptions",
  responses: {
    200: { description: "OK", content: { "application/json": { schema: webhookSubscriptionsResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/webhooks/{id}",
  summary: "Delete a webhook subscription",
  request: {
    params: webhookDeleteParamsSchema,
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: booleanOkResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/webhooks/{id}/deliveries",
  summary: "Webhook delivery log",
  request: {
    params: webhookDeliveriesParamsSchema,
    query: webhookDeliveriesQuerySchema,
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: webhookDeliveriesResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/host-fn/{contractId}",
  summary: "Host function logs",
  request: {
    params: hostFnParamsSchema,
    query: hostFnQuerySchema.omit({ contractId: true }),
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: hostFnLogsResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/nfts/transfers",
  summary: "NFT transfers",
  request: {
    query: nftTransfersQuerySchema,
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: nftTransfersResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/nfts/owners/{contract}/{token_id}",
  summary: "NFT owner lookup",
  request: {
    params: nftOwnerParamsSchema,
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: nftOwnerResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/assets/popular",
  summary: "Popular assets",
  request: {
    query: popularAssetsQuerySchema,
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: popularAssetsResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/search",
  summary: "Fuzzy search across accounts, assets, and contracts",
  request: {
    query: searchQuerySchema,
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: searchResponseSchema } } },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/tokens",
  summary: "Cached token metadata",
  description:
    "All tokens the indexer has encountered and cached, on the selected network. " +
    "Served from the in-memory token cache — a token appears here once the indexer " +
    "has seen a transfer of it and resolved its symbol, name and decimals.",
  request: { query: tokensQuerySchema },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: tokensResponseSchema } } },
    ...commonErrorResponses,
  },
});

const transferExportResponses = {
  200: {
    description: "File download of the full matching transfer set (no pagination).",
    content: {
      "text/csv": { schema: binaryExportResponseSchema },
      "application/octet-stream": { schema: binaryExportResponseSchema },
    },
  },
  ...commonErrorResponses,
};

registry.registerPath({
  method: "get",
  path: "/transfers.csv",
  summary: "Export all transfers as CSV",
  description:
    "Streams every transfer matching the filters as CSV. No pagination: the " +
    "response is the entire matching set, so narrow it with the ledger or date " +
    "bounds on large deployments.",
  request: { query: transferExportQuerySchema },
  responses: transferExportResponses,
});

registry.registerPath({
  method: "get",
  path: "/transfers.parquet",
  summary: "Export all transfers as Parquet",
  description:
    "Streams every transfer matching the filters as an Apache Parquet file. " +
    "Same filters and streaming behaviour as /transfers.csv.",
  request: { query: transferExportQuerySchema },
  responses: transferExportResponses,
});

// Internal surfaces, kept in the spec for completeness. The provider webhook
// is a signature-verified callback from the payout provider and the offramp
// router is the wallet's own cash-out surface fronting a server-side provider
// API — neither is a public data API, so both carry `x-internal`.
//
// `x-internal` rather than `deprecated`: these routes are live and the wallet
// calls them today. `deprecated` tells every generator and every reader that
// the endpoint is being withdrawn, which would read as cash-out being retired.
const internalDescription =
  "Internal endpoint. Not part of the public data API: " +
  "(provider callback / wallet-only cash-out surface served on behalf of the Veil wallet client).";

registry.registerPath({
  method: "post",
  path: "/webhooks/linq",
  summary: "Payout webhook (provider callback)",
  description: internalDescription,
  "x-internal": true,
  responses: {
    200: { description: "Acknowledged", content: { "application/json": { schema: linqWebhookAckResponseSchema } } },
    401: { description: "Invalid signature", content: { "application/json": { schema: errorResponseSchema } } },
    400: { description: "Unrecognised event", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const internalErrorResponses = {
  ...commonErrorResponses,
  502: { description: "Payout provider error", content: { "application/json": { schema: offrampErrorResponseSchema } } },
  503: { description: "Offramp not configured on this deployment", content: { "application/json": { schema: offrampErrorResponseSchema } } },
};

registry.registerPath({
  method: "get",
  path: "/offramp/rate",
  summary: "Indicative NGN/USDC rate",
  description: internalDescription,
  "x-internal": true,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: offrampRateResponseSchema } } },
    ...internalErrorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/offramp/verify-bank",
  summary: "Verify a bank account before creating an order",
  description: internalDescription,
  "x-internal": true,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: offrampVerifyBankBodySchema } },
    },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: offrampVerifiedBankSchema } } },
    ...internalErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/offramp/trustline",
  summary: "Check a refund address holds a USDC trustline",
  description: internalDescription,
  "x-internal": true,
  request: { query: offrampTrustlineQuerySchema },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: offrampTrustlineResponseSchema } } },
    ...internalErrorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/offramp/orders",
  summary: "Create a cash-out order",
  description: internalDescription,
  "x-internal": true,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: offrampOrderBodySchema } },
    },
  },
  responses: {
    201: { description: "Order created", content: { "application/json": { schema: offrampOrderResponseSchema } } },
    200: { description: "Replayed existing order (same idempotencyKey)", content: { "application/json": { schema: offrampOrderResponseSchema } } },
    ...internalErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/offramp/orders/{orderId}",
  summary: "Get the status of a cash-out order",
  description: internalDescription,
  "x-internal": true,
  request: { params: offrampOrderParamsSchema },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: offrampOrderStatusResponseSchema } } },
    ...internalErrorResponses,
  },
});

if (getOhlcRefreshIntervalMs() !== undefined) {
  registry.registerPath({
    method: "get",
    path: "/candles/{bucket}/{contractId}",
    summary: "OHLC candles for a token contract (single-network deployments only)",
    request: {
      params: candlesParamsSchema,
      query: candlesQuerySchema,
    },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: candlesResponseSchema } } },
      ...commonErrorResponses,
    },
  });
}

const generator = new OpenApiGeneratorV3(registry.definitions);
const document = generator.generateDocument({
  openapi: "3.0.3",
  info: {
    title: "Wraith API",
    version: "1.0.0",
    description: "REST API documentation for the Wraith token transfer indexer.",
    license: {
      name: "MIT",
      url: "https://opensource.org/licenses/MIT",
    },
  },
  servers: [
    {
      url: "http://127.0.0.1:3000",
      description: "Local development server",
    },
  ],
});

export function buildOpenApiDocument(): typeof document {
  return document;
}

// Write only when run as a script (npm run docs:openapi). Importing the
// builder from tests must not overwrite the committed spec files — the
// openapiCoverage test compares them against the generated output to catch
// drift, which would be tautological if the import itself refreshed them.
if (require.main === module) {
  const outputFiles = [
    path.resolve(process.cwd(), "openapi.json"),
    path.resolve(process.cwd(), "docs", "openapi.json"),
  ];

  for (const filePath of outputFiles) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }

  console.log(`Wrote OpenAPI document to ${outputFiles.join(" and ")}`);
}
