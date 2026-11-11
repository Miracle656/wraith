import { readdirSync, readFileSync } from "fs";
import path from "path";

/**
 * Client route coverage guard (Issue #310):
 *
 * `openapiCoverage.test.ts` guarantees that every Express route registered on
 * the server appears in the committed `openapi.json`. This suite closes the
 * second half of that loop: every route in `openapi.json` must either be
 * covered by each official client SDK (`react-query`, `go`, `python`) or
 * explicitly listed on that client's allow-list with a documented reason.
 *
 * Like `KNOWN_UNDOCUMENTED` in `openapiCoverage.test.ts`, the allow-list is
 * checked for equality in both directions:
 *  - Adding a new route to `openapi.json` without updating a client (or its
 *    allow-list) fails, naming both the client and the missing route.
 *  - Implementing an allow-listed route in a client without removing it from
 *    the allow-list also fails, so the allow-list can only shrink over time.
 */

export type ClientName = "react-query" | "go" | "python";

const CLIENT_NAMES: readonly ClientName[] = ["react-query", "go", "python"];
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export interface OpenApiSpecLike {
  paths: Record<string, Record<string, unknown>>;
}

/** Extract every documented `method path` key (lowercased) from an OpenAPI document. */
export function collectSpecRoutes(spec: OpenApiSpecLike): Set<string> {
  const routes = new Set<string>();
  for (const [routePath, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const verb of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(verb.toLowerCase())) {
        routes.add(`${verb} ${routePath}`.toLowerCase());
      }
    }
  }
  return routes;
}

/**
 * Walk `clients/react-query/src/hooks/*.ts` and collect every `client.<VERB>("<path>")`
 * call made against the typed `openapi-fetch` client.
 */
export function collectReactQueryRoutes(rootDir: string = process.cwd()): Set<string> {
  const hooksDir = path.resolve(rootDir, "clients/react-query/src/hooks");
  const routes = new Set<string>();
  for (const entry of readdirSync(hooksDir)) {
    if (!entry.endsWith(".ts")) continue;
    const src = readFileSync(path.join(hooksDir, entry), "utf8");
    const callRe = /\bclient\.(GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = callRe.exec(src)) !== null) {
      routes.add(`${match[1]} ${match[2]}`.toLowerCase());
    }
  }
  return routes;
}

function normalizeGoPathExpression(expr: string): string {
  return expr
    .split("+")
    .map((part) => part.trim())
    .map((part) => {
      if (part.startsWith('"') && part.endsWith('"')) {
        return part.slice(1, -1);
      }
      const pathEscape = /^url\.PathEscape\(\s*([A-Za-z0-9_]+)\s*\)$/.exec(part);
      if (pathEscape) return `{${pathEscape[1]}}`;
      const formatInt = /^strconv\.FormatInt\(\s*([A-Za-z0-9_]+)\s*,\s*10\s*\)$/.exec(part);
      if (formatInt) return `{${formatInt[1]}}`;
      return part;
    })
    .join("");
}

/**
 * Walk `clients/go/<pkg>/*.go` (excluding tests and the shared transport package
 * `clients/go/wraith`) and collect every `<client>.c.<Verb>(ctx, <path>, ...)` call.
 */
export function collectGoRoutes(rootDir: string = process.cwd()): Set<string> {
  const goRoot = path.resolve(rootDir, "clients/go");
  const routes = new Set<string>();

  for (const pkgEntry of readdirSync(goRoot, { withFileTypes: true })) {
    if (!pkgEntry.isDirectory() || pkgEntry.name === "wraith") continue;
    const pkgDir = path.join(goRoot, pkgEntry.name);
    for (const file of readdirSync(pkgDir)) {
      if (!file.endsWith(".go") || file.endsWith("_test.go")) continue;
      const src = readFileSync(path.join(pkgDir, file), "utf8");

      // Track local `path := "/webhooks/" + ...` bindings inside endpoint methods.
      const localVars = new Map<string, string>();
      const assignRe = /\b([A-Za-z0-9_]+)\s*:=\s*([^\r\n]+)/g;
      let assignMatch: RegExpExecArray | null;
      while ((assignMatch = assignRe.exec(src)) !== null) {
        if (assignMatch[2].includes('"/')) {
          localVars.set(assignMatch[1], normalizeGoPathExpression(assignMatch[2]));
        }
      }

      const callRe = /\.c\.(Get|Post|Put|Patch|Delete)\(\s*ctx\s*,\s*([^,]+),/g;
      let callMatch: RegExpExecArray | null;
      while ((callMatch = callRe.exec(src)) !== null) {
        const verb = callMatch[1].toLowerCase();
        const rawPathArg = callMatch[2].trim();
        const resolvedPath = localVars.get(rawPathArg) ?? normalizeGoPathExpression(rawPathArg);
        routes.add(`${verb} ${resolvedPath}`.toLowerCase());
      }
    }
  }
  return routes;
}

const PYTHON_PARAM_ALIASES: Record<string, string> = {
  tx_hash: "txhash",
  contract_id: "contractid",
  order_id: "orderid",
};

/**
 * Read `clients/python/wraith/client.py` and collect every `self._<verb>(...)`
 * call, normalising Python f-string placeholders (`{tx_hash}`) to the OpenAPI
 * parameter names (`{txhash}`).
 */
export function collectPythonRoutes(rootDir: string = process.cwd()): Set<string> {
  const clientPy = path.resolve(rootDir, "clients/python/wraith/client.py");
  const src = readFileSync(clientPy, "utf8");
  const routes = new Set<string>();

  const callRe = /self\.(_get|_post|_put|_patch|_delete)\(\s*(f?"[^"]+")/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(src)) !== null) {
    const verb = match[1].slice(1).toLowerCase();
    const rawLiteral = match[2].replace(/^f/, "").slice(1, -1);
    const normalizedPath = rawLiteral.replace(/\{([A-Za-z0-9_]+)\}/g, (_, param: string) => {
      const lowered = param.toLowerCase();
      return `{${PYTHON_PARAM_ALIASES[lowered] ?? lowered}}`;
    });
    routes.add(`${verb} ${normalizedPath}`.toLowerCase());
  }
  return routes;
}

export function collectAllClientRoutes(
  rootDir: string = process.cwd(),
): Record<ClientName, Set<string>> {
  return {
    "react-query": collectReactQueryRoutes(rootDir),
    go: collectGoRoutes(rootDir),
    python: collectPythonRoutes(rootDir),
  };
}

/**
 * Routes in `openapi.json` that are intentionally outside the scope of the
 * public query SDKs across all three clients:
 *  - `x-internal: true` routes (wallet offramp flows, Linq webhook receiver,
 *    operator failure/fee reports).
 *  - Kubernetes / Prometheus operational probes (`/healthz`, `/readyz`, `/metrics`).
 *  - Streaming file downloads (`/transfers.csv`, `/transfers.parquet`,
 *    `/transfers/address/{address}/export.csv`).
 *  - Legacy `/summary/{address}` alias (superseded by `/accounts/{address}/summary`)
 *    and NGN partner-rail endpoints.
 */
export const SHARED_NON_CLIENT_ROUTES: readonly string[] = [
  // x-internal: true routes
  "get /fees/report",
  "get /offramp/availability",
  "get /offramp/orders/{orderid}",
  "get /offramp/rate",
  "get /offramp/trustline",
  "get /ops/failures",
  "post /offramp/orders",
  "post /offramp/verify-bank",
  "post /webhooks/linq",
  // Operational probes & Prometheus metrics
  "get /healthz",
  "get /metrics",
  "get /readyz",
  // Bulk CSV / Parquet download streams
  "get /transfers.csv",
  "get /transfers.parquet",
  "get /transfers/address/{address}/export.csv",
  // Legacy summary alias & NGN partner rails
  "get /ngn/bills/data-bundles",
  "get /ngn/customers/status",
  "get /summary/{address}",
];

/**
 * Per-client allow-list of public API routes in `openapi.json` that each client
 * has not yet wrapped, as of 2026-11-03.
 *
 * When a client implements one of these routes, remove the entry here in the
 * same commit; leaving a covered route on this list fails the check.
 */
export const KNOWN_UNCOVERED_BY_CLIENT: Record<ClientName, readonly string[]> = {
  "react-query": [
    "delete /webhooks/{id}",
    "get /accounts/{address}/balance",
    "get /fees",
    "get /nfts/owners/{contract}/{token_id}",
    "get /search",
    "get /tokens",
    "post /webhooks",
  ],
  go: [
    "delete /webhooks/{id}",
    "get /accounts/{address}/balance",
    "get /fees",
    "get /host-fn/{contractid}",
    "get /nfts/owners/{contract}/{token_id}",
    "get /search",
    "get /tokens",
    "post /webhooks",
  ],
  python: [
    "delete /webhooks/{id}",
    "get /accounts/{address}/balance",
    "get /fees",
    "get /host-fn/{contractid}",
    "get /nfts/owners/{contract}/{token_id}",
    "get /nfts/transfers",
    "get /search",
    "get /status",
    "get /tokens",
    "get /webhooks",
    "get /webhooks/{id}/deliveries",
    "post /webhooks",
  ],
};

/**
 * Compare every client's covered routes against `spec` and the explicit
 * allow-lists. Returns a list of human-readable failure messages naming both
 * the client and the route whenever a gap or stale allow-list entry is found.
 */
export function evaluateClientCoverage(
  spec: OpenApiSpecLike,
  coveredByClient: Record<ClientName, Set<string>> = collectAllClientRoutes(),
  uncoveredAllowListByClient: Record<ClientName, readonly string[]> = KNOWN_UNCOVERED_BY_CLIENT,
  sharedNonClientRoutes: readonly string[] = SHARED_NON_CLIENT_ROUTES,
): string[] {
  const specRoutes = collectSpecRoutes(spec);
  const failures: string[] = [];

  for (const client of CLIENT_NAMES) {
    const covered = coveredByClient[client];
    const allowedUncovered = new Set<string>([
      ...sharedNonClientRoutes.map((r) => r.toLowerCase()),
      ...(uncoveredAllowListByClient[client] ?? []).map((r) => r.toLowerCase()),
    ]);

    // 1. Every route in `openapi.json` must be either covered by the client or allow-listed.
    for (const route of [...specRoutes].sort()) {
      if (!covered.has(route) && !allowedUncovered.has(route)) {
        failures.push(
          `client "${client}" is missing spec route "${route}" (implement it in clients/${client} or add to KNOWN_UNCOVERED_BY_CLIENT["${client}"])`,
        );
      }
    }

    // 2. An allow-listed route that is now covered by the client must be removed from the allow-list.
    for (const route of [...allowedUncovered].sort()) {
      if (covered.has(route)) {
        failures.push(
          `client "${client}" allow-list still contains covered route "${route}" (remove it from KNOWN_UNCOVERED_BY_CLIENT["${client}"])`,
        );
      } else if (!specRoutes.has(route)) {
        failures.push(
          `client "${client}" allow-list references route "${route}" which is not in openapi.json`,
        );
      }
    }

    // 3. Every route a client calls must exist in `openapi.json`.
    for (const route of [...covered].sort()) {
      if (!specRoutes.has(route)) {
        failures.push(
          `client "${client}" calls route "${route}" which does not exist in openapi.json`,
        );
      }
    }
  }

  return failures;
}

const committedSpec = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "openapi.json"), "utf8"),
) as OpenApiSpecLike;

describe("Client route coverage against openapi.json (#310)", () => {
  const coveredByClient = collectAllClientRoutes();

  it.each(CLIENT_NAMES)(
    "client %s covers every route in openapi.json not on its explicit allow-list",
    (client) => {
      const singleClientFailures = evaluateClientCoverage(committedSpec, coveredByClient).filter(
        (msg) => msg.startsWith(`client "${client}"`),
      );
      expect(singleClientFailures).toEqual([]);
    },
  );

  it("extracts the real routes from each client (guards the guard)", () => {
    expect(coveredByClient["react-query"]).toContain("get /accounts/{address}/summary");
    expect(coveredByClient["react-query"]).toContain("get /host-fn/{contractid}");
    expect(coveredByClient["react-query"]).toContain("get /webhooks/{id}/deliveries");

    expect(coveredByClient.go).toContain("get /accounts/{address}/summary");
    expect(coveredByClient.go).toContain("get /nfts/transfers");
    expect(coveredByClient.go).toContain("get /webhooks/{id}/deliveries");

    expect(coveredByClient.python).toContain("get /accounts/{address}/summary");
    expect(coveredByClient.python).toContain("get /assets/popular");
    expect(coveredByClient.python).toContain("get /transfers/tx/{txhash}");
  });

  it("adding a fake route to openapi.json fails the check, naming the route and each client", () => {
    const specWithFakeRoute: OpenApiSpecLike = {
      paths: {
        ...committedSpec.paths,
        "/v99/fake-unhandled-route/{id}": {
          get: { summary: "Synthetic route added to verify client drift detection" },
        },
      },
    };

    const failures = evaluateClientCoverage(specWithFakeRoute, coveredByClient);

    expect(failures).toHaveLength(3);
    for (const client of CLIENT_NAMES) {
      const matching = failures.find(
        (msg) =>
          msg.includes(client) && msg.includes("get /v99/fake-unhandled-route/{id}"),
      );
      expect(matching).toBeDefined();
    }
  });

  it("fails naming the client and route when a newly-covered route is left on the allow-list", () => {
    const simulatedGoCoverage = new Set(coveredByClient.go);
    simulatedGoCoverage.add("get /fees");

    const failures = evaluateClientCoverage(committedSpec, {
      ...coveredByClient,
      go: simulatedGoCoverage,
    });

    expect(failures).toEqual([
      'client "go" allow-list still contains covered route "get /fees" (remove it from KNOWN_UNCOVERED_BY_CLIENT["go"])',
    ]);
  });
});
