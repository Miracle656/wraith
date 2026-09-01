import { Request, Response, NextFunction } from "express";

const JSON_API_MEDIA_TYPE = "application/vnd.api+json";

function isJsonApiRequest(req: Request): boolean {
  const accept = req.headers.accept;
  if (!accept) return false;
  const types = Array.isArray(accept)
    ? accept
    : accept.split(",").map((t) => t.trim().split(";")[0].trim());
  return types.includes(JSON_API_MEDIA_TYPE);
}

type JsonApiResource = {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, JsonApiResourceIdentifier | JsonApiResourceIdentifier[]>;
};

type JsonApiResourceIdentifier = {
  id: string;
  type: string;
};

type JsonApiResponse = {
  data?: JsonApiResource | JsonApiResource[] | null;
  meta?: Record<string, unknown>;
  links?: Record<string, string>;
  errors?: JsonApiError[];
};

type JsonApiError = {
  status?: string;
  code?: string;
  title: string;
  detail?: string;
};

function determineResourceType(endpoint: string, body: unknown): string | null {
  if (endpoint.includes("/transfers/address/")) return "transfer";
  if (endpoint.includes("/transfers/incoming/")) return "transfer";
  if (endpoint.includes("/transfers/outgoing/")) return "transfer";
  if (endpoint.includes("/transfers/tx/")) return "transfer";
  if (endpoint.includes("/summary/")) return "token-summary";
  if (endpoint.includes("/accounts/")) return "account-summary";
  if (endpoint.includes("/assets/popular")) return "popular-asset";
  if (endpoint.includes("/nfts/transfers")) return "nft-transfer";
  if (endpoint.includes("/nfts/owners/")) return "nft-owner";
  if (endpoint.includes("/status")) return "status";
  if (endpoint.includes("/healthz")) return "health";
  if (endpoint.includes("/readyz")) return "readiness";
  return null;
}

function toResourceId(record: Record<string, unknown>, type: string): string {
  switch (type) {
    case "transfer":
      return String((record as { eventId?: unknown }).eventId ?? record.id ?? "");
    case "token-summary":
    case "account-summary":
      return String((record as { contractId?: unknown }).contractId ?? "");
    case "popular-asset":
      return String((record as { contractId?: unknown }).contractId ?? "");
    case "nft-transfer":
      return String((record as { eventId?: unknown }).eventId ?? record.id ?? "");
    case "nft-owner":
      return `${String((record as { contract?: unknown }).contract ?? "")}-${String((record as { token_id?: unknown }).token_id ?? record.tokenId ?? "")}`;
    default:
      return String(record.id ?? record.contractId ?? "");
  }
}

function recordToResource(record: Record<string, unknown>, type: string): JsonApiResource {
  const { id, ...attributes } = record;
  const resourceId = toResourceId(record, type);

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value instanceof Date) {
      normalized[key] = value.toISOString();
    } else if (typeof value === "bigint") {
      normalized[key] = value.toString();
    } else {
      normalized[key] = value;
    }
  }

  const resource: JsonApiResource = {
    id: resourceId,
    type,
    attributes: normalized,
  };

  return resource;
}

function transformTransfersResponse(body: { transfers: Record<string, unknown>[]; total?: number; limit?: number; offset?: number; nextCursor?: string | null }, endpoint: string): { data: JsonApiResource[]; meta: Record<string, unknown> } {
  const type = determineResourceType(endpoint, body) ?? "transfer";
  const data = body.transfers.map((t) => recordToResource(t as Record<string, unknown>, type));
  const meta: Record<string, unknown> = {};
  if (typeof body.total === "number") meta.total = body.total;
  if (typeof body.limit === "number") meta.limit = body.limit;
  if (typeof body.offset === "number") meta.offset = body.offset;
  if (body.nextCursor) meta.nextCursor = body.nextCursor;
  return { data, meta };
}

function transformSummaryResponse(body: { address: string; window: { fromDate?: Date | null; toDate?: Date | null }; tokens: Record<string, unknown>[] }, endpoint: string): { data: JsonApiResource[]; meta: Record<string, unknown> } {
  const type = determineResourceType(endpoint, body) ?? "token-summary";
  const data = body.tokens.map((t) => recordToResource(t as Record<string, unknown>, type));
  const meta: Record<string, unknown> = {
    address: body.address,
    window: {
      fromDate: body.window.fromDate?.toISOString() ?? null,
      toDate: body.window.toDate?.toISOString() ?? null,
    },
  };
  return { data, meta };
}

function transformAssetsResponse(body: { window: string; by: string; limit: number; offset: number; total: number; assets: Record<string, unknown>[] }): { data: JsonApiResource[]; meta: Record<string, unknown> } {
  const data = body.assets.map((a) => recordToResource(a as Record<string, unknown>, "popular-asset"));
  const meta = {
    window: body.window,
    by: body.by,
    limit: body.limit,
    offset: body.offset,
    total: body.total,
  };
  return { data, meta };
}

function transformNftTransfersResponse(body: { transfers: Record<string, unknown>[]; total?: number; limit?: number; offset?: number; nextCursor?: string | null }): { data: JsonApiResource[]; meta: Record<string, unknown> } {
  const data = body.transfers.map((t) => recordToResource(t as Record<string, unknown>, "nft-transfer"));
  const meta: Record<string, unknown> = {};
  if (typeof body.total === "number") meta.total = body.total;
  if (typeof body.limit === "number") meta.limit = body.limit;
  if (typeof body.offset === "number") meta.offset = body.offset;
  if (body.nextCursor) meta.nextCursor = body.nextCursor;
  return { data, meta };
}

function transformNftOwnerResponse(body: { contract: string; token_id: string; owner?: string; metadata?: { name: string | null; tokenUri: string | null } | null }): { data: JsonApiResource | null; meta: Record<string, unknown> } {
  const data = body.owner
    ? recordToResource({ ...body, id: `${body.contract}-${body.token_id}` } as Record<string, unknown>, "nft-owner")
    : null;
  const meta = {
    contract: body.contract,
    token_id: body.token_id,
  };
  return { data, meta };
}

function transformSimpleResponse(body: Record<string, unknown>, endpoint: string): { data: JsonApiResource; meta: Record<string, unknown> } {
  const type = determineResourceType(endpoint, body);
  if (type) {
    return { data: recordToResource(body, type), meta: {} };
  }
  return { data: { id: "1", type: "generic", attributes: body }, meta: {} };
}

export function jsonApiMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" && isJsonApiRequest(req)) {
    const originalJson = res.json.bind(res);

    res.json = (function (this: Response, body: unknown): Response {
      const statusCode = res.statusCode || 200;
      const jsonApiBody = transformToJsonApi(body, req.path, statusCode);
      this.setHeader("Content-Type", JSON_API_MEDIA_TYPE);
      return originalJson(jsonApiBody);
    }).bind(res) as typeof res.json;
  }
  next();
}

function transformToJsonApi(body: unknown, endpoint: string, statusCode: number = 200): JsonApiResponse {
  if (!body || typeof body !== "object") {
    return { data: null };
  }

  const bodyRecord = body as Record<string, unknown>;

  if (bodyRecord.transfers && Array.isArray(bodyRecord.transfers)) {
    return transformTransfersResponse(bodyRecord as { transfers: Record<string, unknown>[]; total?: number; limit?: number; offset?: number; nextCursor?: string | null }, endpoint) as unknown as JsonApiResponse;
  }

  if (bodyRecord.tokens && Array.isArray(bodyRecord.tokens)) {
    return transformSummaryResponse(bodyRecord as { address: string; window: { fromDate?: Date | null; toDate?: Date | null }; tokens: Record<string, unknown>[] }, endpoint) as unknown as JsonApiResponse;
  }

  if (bodyRecord.assets && Array.isArray(bodyRecord.assets)) {
    return transformAssetsResponse(bodyRecord as { window: string; by: string; limit: number; offset: number; total: number; assets: Record<string, unknown>[] }) as unknown as JsonApiResponse;
  }

  if (bodyRecord.contract && bodyRecord.token_id) {
    return transformNftOwnerResponse(bodyRecord as { contract: string; token_id: string; owner?: string; metadata?: { name: string | null; tokenUri: string | null } | null }) as unknown as JsonApiResponse;
  }

  if (bodyRecord.error) {
    return {
      errors: [{
        status: String(statusCode),
        title: "Error",
        detail: String(bodyRecord.error),
      }],
    };
  }

  return transformSimpleResponse(bodyRecord, endpoint) as unknown as JsonApiResponse;
}
