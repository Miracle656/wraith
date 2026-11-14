import type { Application, Response } from "express";
import { buildOpenApiDocument } from "./build";

type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;

type SchemaObject = {
  $ref?: string;
  type?: string;
  nullable?: boolean;
  enum?: unknown[];
  properties?: Record<string, SchemaObject>;
  required?: string[];
  additionalProperties?: boolean | SchemaObject;
  items?: SchemaObject;
  anyOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  allOf?: SchemaObject[];
};

/**
 * Routes registered on the app that are not yet in `openapi.json` (#291),
 * kept in lockstep with `KNOWN_UNDOCUMENTED` in `openapiCoverage.test.ts`.
 */
export const KNOWN_UNDOCUMENTED_ROUTES = new Set<string>([
  "get /ngn/bills/{orderid}",
  "get /ngn/onramp/orders/{orderid}",
  "get /ngn/onramp/rate",
  "post /ngn/bills",
  "post /ngn/customers",
  "post /ngn/customers/kyc",
  "post /ngn/onramp/orders",
]);

let cachedSpec: OpenApiDocument | null = null;

function getDefaultSpec(): OpenApiDocument {
  if (!cachedSpec) {
    cachedSpec = buildOpenApiDocument();
  }
  return cachedSpec;
}

function normalizePathname(rawUrl: string): string {
  const withoutQuery = rawUrl.split("?")[0] || "/";
  const withBraces = withoutQuery.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  if (withBraces.length > 1 && withBraces.endsWith("/")) {
    return withBraces.slice(0, -1);
  }
  return withBraces;
}

function templateToRegex(openApiPath: string): RegExp {
  const escaped = openApiPath
    .split(/(\{[A-Za-z0-9_]+\})/g)
    .map((segment) =>
      segment.startsWith("{") && segment.endsWith("}")
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${escaped}$`, "i");
}

function matchOpenApiPath(
  pathname: string,
  paths: Record<string, unknown>,
): string | null {
  if (Object.prototype.hasOwnProperty.call(paths, pathname)) {
    return pathname;
  }
  const candidates = Object.keys(paths);
  for (const candidate of candidates) {
    if (templateToRegex(candidate).test(pathname)) {
      return candidate;
    }
  }
  return null;
}

function isKnownUndocumented(method: string, pathname: string): boolean {
  const m = method.toLowerCase();
  for (const entry of KNOWN_UNDOCUMENTED_ROUTES) {
    const [entryMethod, entryPath] = entry.split(" ");
    if (entryMethod === m && templateToRegex(entryPath).test(pathname)) {
      return true;
    }
  }
  return false;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  return typeof value;
}

function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

function resolveRef(schema: SchemaObject, spec: OpenApiDocument): SchemaObject {
  if (!schema.$ref) return schema;
  const prefix = "#/components/schemas/";
  if (schema.$ref.startsWith(prefix)) {
    const name = schema.$ref.slice(prefix.length);
    const schemas = (spec as { components?: { schemas?: Record<string, SchemaObject> } })
      .components?.schemas;
    if (schemas && schemas[name]) {
      return schemas[name];
    }
  }
  return schema;
}

function validateValueAgainstSchema(
  rawSchema: SchemaObject,
  value: unknown,
  fieldPath: string,
  spec: OpenApiDocument,
): string[] {
  const schema = resolveRef(rawSchema, spec);
  const label = fieldPath || "<root>";

  if (value === null) {
    if (schema.nullable === true) return [];
    return [
      `field \`${label}\` has wrong type: expected ${schema.type ?? "non-null"}, got null`,
    ];
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.flatMap((sub) =>
      validateValueAgainstSchema(sub, value, fieldPath, spec),
    );
  }

  const unionBranches = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(unionBranches) && unionBranches.length > 0) {
    const branchErrors = unionBranches.map((branch) =>
      validateValueAgainstSchema(branch, value, fieldPath, spec),
    );
    if (branchErrors.some((errs) => errs.length === 0)) {
      return [];
    }
    return branchErrors[0] ?? [`field \`${label}\` did not match any union schema`];
  }

  const errors: string[] = [];

  if (schema.type === "object" || schema.properties || schema.additionalProperties) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [
        `field \`${label}\` has wrong type: expected object, got ${describeType(value)}`,
      ];
    }

    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};

    for (const reqKey of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, reqKey) || record[reqKey] === undefined) {
        errors.push(`response is missing required field \`${joinPath(fieldPath, reqKey)}\``);
      }
    }

    for (const [key, propValue] of Object.entries(record)) {
      if (propValue === undefined) continue;
      const childPath = joinPath(fieldPath, key);

      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(
          ...validateValueAgainstSchema(properties[key], propValue, childPath, spec),
        );
      } else if (schema.additionalProperties) {
        if (typeof schema.additionalProperties === "object") {
          errors.push(
            ...validateValueAgainstSchema(
              schema.additionalProperties,
              propValue,
              childPath,
              spec,
            ),
          );
        }
      } else if (schema.properties !== undefined) {
        errors.push(`response has an extra field \`${childPath}\``);
      }
    }

    return errors;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      return [
        `field \`${label}\` has wrong type: expected array, got ${describeType(value)}`,
      ];
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        errors.push(
          ...validateValueAgainstSchema(
            schema.items,
            value[i],
            `${fieldPath || ""}[${i}]`,
            spec,
          ),
        );
      }
    }
    return errors;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      return [
        `field \`${label}\` has wrong type: expected string, got ${describeType(value)}`,
      ];
    }
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return [
        `field \`${label}\` has wrong type: expected number, got ${describeType(value)}`,
      ];
    }
  } else if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return [
        `field \`${label}\` has wrong type: expected integer, got ${describeType(value)}`,
      ];
    }
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") {
      return [
        `field \`${label}\` has wrong type: expected boolean, got ${describeType(value)}`,
      ];
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(
      `field \`${label}\` has value ${JSON.stringify(value)}, expected one of ${JSON.stringify(schema.enum)}`,
    );
  }

  return errors;
}

export interface ValidateOpenApiOptions {
  spec?: OpenApiDocument;
  /**
   * When true (default for Express app instrumentation), routes in
   * `KNOWN_UNDOCUMENTED_ROUTES` (#291) are skipped rather than failing for
   * having no spec entry yet.
   */
  skipKnownUndocumented?: boolean;
}

/**
 * Validate a response body against the OpenAPI schema for `(method, path, status)`.
 *
 * Returns a list of human-readable field divergence descriptions (empty when valid).
 */
export function validateOpenApiResponse(
  method: string,
  rawPath: string,
  status: number,
  body: unknown,
  options: ValidateOpenApiOptions = {},
): string[] {
  const spec = options.spec ?? getDefaultSpec();
  const pathname = normalizePathname(rawPath);
  const verb = method.toLowerCase();

  const matchedPath = matchOpenApiPath(pathname, spec.paths as Record<string, unknown>);
  if (!matchedPath) {
    if (options.skipKnownUndocumented && isKnownUndocumented(verb, pathname)) {
      return [];
    }
    return [`route ${method.toUpperCase()} ${pathname} is not documented in the OpenAPI spec`];
  }

  const pathItem = (spec.paths as Record<string, Record<string, unknown>>)[matchedPath];
  const operation = pathItem?.[verb] as
    | {
        responses?: Record<
          string,
          { content?: Record<string, { schema?: SchemaObject }> }
        >;
      }
    | undefined;

  if (!operation) {
    if (options.skipKnownUndocumented && isKnownUndocumented(verb, pathname)) {
      return [];
    }
    return [
      `method ${method.toUpperCase()} is not documented on path ${matchedPath} in the OpenAPI spec`,
    ];
  }

  const responses = operation.responses ?? {};
  const statusEntry = responses[String(status)];
  if (!statusEntry) {
    const documented = Object.keys(responses).sort().join(", ") || "none";
    return [
      `status ${status} is not documented for ${method.toUpperCase()} ${matchedPath} (documented: ${documented})`,
    ];
  }

  const jsonSchema = statusEntry.content?.["application/json"]?.schema;
  if (!jsonSchema) {
    return [];
  }

  return validateValueAgainstSchema(jsonSchema, body, "", spec);
}

/**
 * Assert that a response body conforms to the OpenAPI spec for `(method, path, status)`.
 * Throws an `Error` naming every diverging field and direction if validation fails.
 */
export function assertOpenApiResponse(
  method: string,
  rawPath: string,
  status: number,
  body: unknown,
  options: ValidateOpenApiOptions = {},
): void {
  const divergences = validateOpenApiResponse(method, rawPath, status, body, options);
  if (divergences.length > 0) {
    throw new Error(
      `OpenAPI response schema mismatch for ${method.toUpperCase()} ${normalizePathname(rawPath)} (${status}):\n` +
        divergences.map((d) => `  - ${d}`).join("\n"),
    );
  }
}

const pendingValidationErrors: Error[] = [];

const globalAfterEach = (globalThis as { afterEach?: (fn: () => void) => void }).afterEach;
if (typeof globalAfterEach === "function") {
  globalAfterEach(() => {
    if (pendingValidationErrors.length > 0) {
      const errors = pendingValidationErrors.splice(0, pendingValidationErrors.length);
      if (errors.length === 1) {
        throw errors[0];
      }
      throw new Error(errors.map((e) => e.message).join("\n\n"));
    }
  });
}

/**
 * Drain and return any pending OpenAPI response validation errors collected
 * during the current test without waiting for `afterEach`.
 */
export function consumeOpenApiValidationErrors(): Error[] {
  return pendingValidationErrors.splice(0, pendingValidationErrors.length);
}

/**
 * Instrument an Express `app` so every `res.json(body)` response is validated
 * against the OpenAPI spec for that route and status code.
 *
 * Wraps `app.response.json` directly rather than adding middleware, so route
 * mounting order and raw-body verification (such as `/webhooks/linq`) are
 * never altered. Validation errors are surfaced at the end of the test via
 * `afterEach` so route-level `try / catch` blocks cannot swallow them.
 */
export function withOpenApiResponseValidation<T extends Application>(
  app: T,
  options: ValidateOpenApiOptions = {},
): T {
  const responseProto = (app as unknown as { response: Response }).response;
  const originalJson = responseProto.json;
  responseProto.json = function (this: Response, body?: unknown): Response {
    const req = this.req;
    if (req) {
      const rawUrl = req.originalUrl || req.url || "/";
      const status = this.statusCode || 200;
      const divergences = validateOpenApiResponse(req.method, rawUrl, status, body, {
        skipKnownUndocumented: true,
        ...options,
      });
      if (divergences.length > 0) {
        pendingValidationErrors.push(
          new Error(
            `OpenAPI response schema mismatch for ${req.method.toUpperCase()} ${normalizePathname(rawUrl)} (${status}):\n` +
              divergences.map((d) => `  - ${d}`).join("\n"),
          ),
        );
      }
    }
    return originalJson.call(this, body);
  };

  return app;
}
