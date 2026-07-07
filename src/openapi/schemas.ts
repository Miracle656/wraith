import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

const firstValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value[0];
  return value;
};

const queryString = (description?: string) =>
  z.preprocess(
    firstValue,
    z
      .string()
      .trim()
      .openapi({ description })
  );

const optionalQueryString = (description?: string) =>
  z.preprocess(
    (value) => {
      const raw = firstValue(value);
      if (raw === undefined || raw === null || raw === "") return undefined;
      return raw;
    },
    z
      .string()
      .trim()
      .optional()
      .openapi({ description })
  );

const optionalQueryDateTime = (description?: string) =>
  z.preprocess(
    (value) => {
      const raw = firstValue(value);
      if (raw === undefined || raw === null || raw === "") return undefined;
      return raw;
    },
    z
      .string()
      .datetime({ offset: true, message: "Invalid date" })
      .transform((value) => new Date(value))
      .optional()
      .openapi({ description })
  );

const optionalQueryInt = (options: { min?: number; max?: number; description?: string } = {}) =>
  z.preprocess(
    (value) => {
      const raw = firstValue(value);
      if (raw === undefined || raw === null || raw === "") return undefined;
      return raw;
    },
    z
      .coerce
      .number()
      .int()
      .refine((value) => options.min === undefined || value >= options.min, {
        message: options.min === undefined ? "Invalid integer" : `Must be >= ${options.min}`,
      })
      .refine((value) => options.max === undefined || value <= options.max, {
        message: options.max === undefined ? "Invalid integer" : `Must be <= ${options.max}`,
      })
      .optional()
      .openapi({ description: options.description })
  );

const queryIntWithDefault = (defaultValue: number, options: { min?: number; max?: number; description?: string } = {}) =>
  z.preprocess(
    (value) => {
      const raw = firstValue(value);
      if (raw === undefined || raw === null || raw === "") return defaultValue;
      return raw;
    },
    z
      .coerce
      .number()
      .int()
      .refine((value) => options.min === undefined || value >= options.min, {
        message: options.min === undefined ? "Invalid integer" : `Must be >= ${options.min}`,
      })
      .refine((value) => options.max === undefined || value <= options.max, {
        message: options.max === undefined ? "Invalid integer" : `Must be <= ${options.max}`,
      })
      .default(defaultValue)
      .openapi({ description: options.description })
  );

const optionalCommaList = (items: z.ZodTypeAny, description?: string) =>
  z.preprocess(
    (value) => {
      const raw = firstValue(value);
      if (raw === undefined || raw === null || raw === "") return undefined;
      if (typeof raw !== "string") return raw;
      return raw.split(",").map((part) => part.trim()).filter(Boolean);
    },
    z.array(items).optional().openapi({ description })
  );

const contractAddressSchema = z
  .string()
  .regex(/^C[A-Z2-7]{55}$/, 'Invalid token address: Must be a 56-character Stellar contract address starting with "C"')
  .openapi({ example: "CB64D3G7SM2RTH6ISYIG4P2IYYD6J2OFR6B" });

const stellarAddressSchema = z
  .string()
  .min(1)
  .openapi({ example: "GABCDEFGHIJKLMNOPQRSTUVWXYZ" });

const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .openapi({ example: "2025-01-01T00:00:00Z" });

export const eventTypeEnum = z.enum(["transfer", "mint", "burn", "clawback"]);
const eventTypeQuerySchema = z.preprocess(
  (value) => {
    const raw = firstValue(value);
    if (raw === undefined || raw === null || raw === "") return undefined;
    if (typeof raw !== "string") return raw;
    return raw.split(",").map((part) => part.trim()).filter(Boolean);
  },
  z.array(z.string()).superRefine((items, ctx) => {
    const invalid = items.filter((item) => !["transfer", "mint", "burn", "clawback"].includes(item));
    if (invalid.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid eventType: "${invalid.join('", "')}". Valid values: transfer, mint, burn, clawback.`,
      });
    }
  }).optional()
);

export const errorResponseSchema = z.object({
  error: z.string(),
});

export const booleanOkResponseSchema = z.object({
  ok: z.literal(true),
});

export const healthzResponseSchema = z.object({
  ok: z.literal(true),
  uptime: z.number(),
});

export const readyzResponseSchema = z.object({
  ok: z.boolean(),
  checks: z.object({
    db: z.boolean(),
    rpc: z.boolean(),
    indexerCaughtUp: z.boolean(),
  }),
});

export const statusResponseSchema = z.object({
  ok: z.literal(true),
  lastIndexedLedger: z.number().int().nullable(),
  latestLedger: z.number().int(),
  lagLedgers: z.number().int(),
  startedAt: z.string().datetime({ offset: true }),
  uptimeSeconds: z.number().int(),
  totalIndexed: z.number().int(),
});

export const transferSchema = z.object({
  id: z.number().int(),
  contractId: contractAddressSchema,
  eventType: eventTypeEnum,
  fromAddress: stellarAddressSchema.nullable(),
  toAddress: stellarAddressSchema.nullable(),
  amount: z.string(),
  displayAmount: z.string(),
  ledger: z.number().int(),
  ledgerClosedAt: z.string().datetime({ offset: true }),
  txHash: z.string(),
  eventId: z.string(),
  direction: z.enum(["incoming", "outgoing"]).optional(),
});

export const transferListResponseSchema = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  nextCursor: z.string().nullable().optional(),
  transfers: z.array(transferSchema),
});

export const txTransfersResponseSchema = z.object({
  transfers: z.array(transferSchema),
});

export const tokenSummarySchema = z.object({
  contractId: contractAddressSchema,
  totalReceived: z.string(),
  totalSent: z.string(),
  netFlow: z.string(),
  displayTotalReceived: z.string(),
  displayTotalSent: z.string(),
  displayNetFlow: z.string(),
  txCount: z.number().int(),
});

export const summaryResponseSchema = z.object({
  address: stellarAddressSchema,
  window: z.object({
    fromDate: isoDateTimeSchema.nullable(),
    toDate: isoDateTimeSchema.nullable(),
  }),
  tokens: z.array(tokenSummarySchema),
});

export const webhookFilterSchema = z
  .object({
    contract: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    min_amount: z.string().optional(),
  })
  .strict();

export const webhookCreateRequestSchema = z.object({
  url: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://") || value.startsWith("http://"), {
      message: "url must start with http:// or https://",
    }),
  secret: z.string().min(1),
  filter: webhookFilterSchema.optional().nullable(),
  active: z.boolean().optional(),
});

export const webhookSignatureVerificationSchema = z.object({
  header: z.literal("X-Wraith-Signature"),
  algorithm: z.literal("sha256"),
  format: z.string(),
  body: z.string(),
  example: z.string(),
  safeCompare: z.string(),
});

export const webhookCreatedResponseSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  filter: webhookFilterSchema.nullable(),
  active: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  signatureVerification: webhookSignatureVerificationSchema,
});

export const webhookSubscriptionSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  filter: webhookFilterSchema.nullable(),
  active: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export const webhookSubscriptionsResponseSchema = z.object({
  subscriptions: z.array(webhookSubscriptionSchema),
});

export const webhookDeliverySchema = z.object({
  id: z.number().int(),
  eventId: z.string(),
  status: z.string(),
  attempts: z.number().int(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  nextRetryAt: z.string().datetime({ offset: true }).nullable(),
  deliveredAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});

export const webhookDeliveriesResponseSchema = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  deliveries: z.array(webhookDeliverySchema),
});

export const hostFnLogSchema = z.object({
  contractId: contractAddressSchema,
  functionName: z.string(),
  args: z.any(),
  result: z.any().nullable(),
  gasUsed: z.string().nullable(),
  ledger: z.number().int(),
  ledgerClosedAt: z.string().datetime({ offset: true }),
  txHash: z.string(),
  eventId: z.string(),
});

export const hostFnLogsResponseSchema = z.object({
  contractId: contractAddressSchema,
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  logs: z.array(hostFnLogSchema),
});

export const nftTransferSchema = z.object({
  id: z.number().int(),
  contractId: contractAddressSchema,
  tokenId: z.string(),
  fromAddress: stellarAddressSchema.nullable(),
  toAddress: stellarAddressSchema.nullable(),
  ledger: z.number().int(),
  ledgerClosedAt: z.string().datetime({ offset: true }),
  txHash: z.string(),
  eventId: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});

export const nftTransfersResponseSchema = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  nextCursor: z.string().nullable().optional(),
  transfers: z.array(nftTransferSchema),
});

export const nftOwnerResponseSchema = z.object({
  contract: contractAddressSchema,
  token_id: z.string(),
  owner: stellarAddressSchema,
  metadata: z.object({
    name: z.string().nullable(),
    tokenUri: z.string().nullable(),
  }).nullable(),
});

export const popularAssetSchema = z.object({
  contractId: contractAddressSchema,
  transferCount: z.number().int(),
  volume: z.string(),
  displayVolume: z.string(),
});

export const popularAssetsResponseSchema = z.object({
  window: z.enum(["1h", "24h", "7d"]),
  by: z.enum(["transfers", "volume"]),
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
  assets: z.array(popularAssetSchema),
});

export const searchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(1, "Query parameter 'q' is required")
    .max(80, "Query is too long"),
}).passthrough();

export const searchHitSchema = z.object({
  type: z.enum(["account", "asset", "contract"]),
  value: z.string(),
  isSac: z.boolean().optional(),
  lastActivityAt: z.string().optional(),
});

export const searchResponseSchema = z.object({
  query: z.string(),
  count: z.number().int(),
  results: z.array(searchHitSchema),
});

export const candlesResponseSchema = z.object({
  bucket: z.enum(["1m", "1h", "1d"]),
  contractId: contractAddressSchema,
  candles: z.array(
    z.object({
      timeBucket: z.string(),
      contractId: contractAddressSchema,
      open: z.string(),
      high: z.string(),
      low: z.string(),
      close: z.string(),
      volume: z.string(),
      txCount: z.number().int(),
    })
  ),
});

export const candleRefreshResponseSchema = z.object({
  oneMinute: z.object({ inserted: z.number().int(), updated: z.number().int() }),
  oneHour: z.object({ inserted: z.number().int(), updated: z.number().int() }),
  oneDay: z.object({ inserted: z.number().int(), updated: z.number().int() }),
});

export const transferQuerySchema = z.object({
  address: stellarAddressSchema,
  contractId: optionalQueryString("Token contract ID to filter by"),
  token: contractAddressSchema.optional(),
  fromLedger: optionalQueryInt({ min: 0 }),
  toLedger: optionalQueryInt({ min: 0 }),
  fromDate: optionalQueryDateTime("Inclusive lower bound on ledgerClosedAt"),
  toDate: optionalQueryDateTime("Inclusive upper bound on ledgerClosedAt"),
  eventType: eventTypeQuerySchema.openapi({ description: "Comma-separated list of event types" }),
  limit: queryIntWithDefault(50, { min: 1, max: 200, description: "Page size" }),
  offset: queryIntWithDefault(0, { min: 0, description: "Pagination offset" }),
  cursor: optionalQueryString("Opaque pagination cursor"),
  $filter: optionalQueryString("OData filter expression"),
  $select: optionalCommaList(z.string(), "Comma-separated field list"),
}).passthrough();

export const summaryQuerySchema = z.object({
  address: stellarAddressSchema,
  contractId: optionalQueryString("Token contract ID to filter by"),
  fromDate: optionalQueryDateTime("Inclusive lower bound on ledgerClosedAt"),
  toDate: optionalQueryDateTime("Inclusive upper bound on ledgerClosedAt"),
}).passthrough();

export const txHashParamsSchema = z.object({
  txHash: queryString("Transaction hash"),
}).passthrough();

export const hostFnQuerySchema = z.object({
  contractId: contractAddressSchema,
  functionName: optionalQueryString("Host function name to filter by"),
  limit: queryIntWithDefault(50, { min: 1, max: 200, description: "Page size" }),
  offset: queryIntWithDefault(0, { min: 0, description: "Pagination offset" }),
}).passthrough();

export const nftTransfersQuerySchema = z.object({
  contract: optionalQueryString("NFT contract ID to filter by"),
  token_id: optionalQueryString("NFT token identifier"),
  address: optionalQueryString("Filter by sender or recipient address"),
  fromLedger: optionalQueryInt({ min: 0 }),
  toLedger: optionalQueryInt({ min: 0 }),
  limit: queryIntWithDefault(50, { min: 1, max: 200, description: "Page size" }),
  offset: queryIntWithDefault(0, { min: 0, description: "Pagination offset" }),
  cursor: optionalQueryString("Opaque pagination cursor"),
  $filter: optionalQueryString("OData filter expression"),
  $select: optionalCommaList(z.string(), "Comma-separated field list"),
}).passthrough();

export const nftOwnerParamsSchema = z.object({
  contract: contractAddressSchema,
  token_id: z.string().min(1),
}).passthrough();

export const readyzQuerySchema = z.object({
  maxLag: queryIntWithDefault(100, { min: 0, description: "Max acceptable ledger lag" }),
}).passthrough();

export const popularAssetsQuerySchema = z.object({
  window: z.enum(["1h", "24h", "7d"]).default("24h"),
  by: z.enum(["transfers", "volume"]).default("transfers"),
  limit: queryIntWithDefault(20, { min: 1, max: 100, description: "Page size" }),
  offset: queryIntWithDefault(0, { min: 0, description: "Pagination offset" }),
}).passthrough();

export const webhookDeliveriesQuerySchema = z.object({
  status: z.enum(["pending", "success", "failed"]).optional(),
  limit: queryIntWithDefault(50, { min: 1, max: 200, description: "Page size" }),
  offset: queryIntWithDefault(0, { min: 0, description: "Pagination offset" }),
}).passthrough();

export const webhookDeleteParamsSchema = z.object({
  id: z.coerce.number().int(),
}).passthrough();

export const webhookDeliveriesParamsSchema = z.object({
  id: z.coerce.number().int(),
}).passthrough();

export const webhookCreateBodySchema = webhookCreateRequestSchema;

export const addressPathSchema = z.object({
  address: stellarAddressSchema,
}).passthrough();

export const candlesParamsSchema = z.object({
  bucket: z.enum(["1m", "1h", "1d"]),
  contractId: contractAddressSchema,
}).passthrough();

export const candlesQuerySchema = z.object({
  limit: queryIntWithDefault(100, { min: 1, max: 1000, description: "Page size" }),
  offset: queryIntWithDefault(0, { min: 0, description: "Pagination offset" }),
}).passthrough();

export const candleRefreshRequestSchema = z.object({}).passthrough();

export const hostFnParamsSchema = z.object({
  contractId: contractAddressSchema,
});

export type TransferQuery = z.infer<typeof transferQuerySchema>;
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;
export type HostFnQuery = z.infer<typeof hostFnQuerySchema>;
export type NftTransfersQuery = z.infer<typeof nftTransfersQuerySchema>;
