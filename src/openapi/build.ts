import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import {
  addressPathSchema,
  booleanOkResponseSchema,
  errorResponseSchema,
  healthzResponseSchema,
  hostFnLogsResponseSchema,
  hostFnParamsSchema,
  hostFnQuerySchema,
  nftOwnerParamsSchema,
  nftOwnerResponseSchema,
  nftTransfersQuerySchema,
  nftTransfersResponseSchema,
  popularAssetsQuerySchema,
  popularAssetsResponseSchema,
  readyzQuerySchema,
  readyzResponseSchema,
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
  path: "/status",
  summary: "Indexer status",
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

const outputFiles = [
  path.resolve(process.cwd(), "openapi.json"),
  path.resolve(process.cwd(), "docs", "openapi.json"),
];

for (const filePath of outputFiles) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

console.log(`Wrote OpenAPI document to ${outputFiles.join(" and ")}`);
