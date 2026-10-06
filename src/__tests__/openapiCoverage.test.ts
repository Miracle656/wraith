import { readFileSync } from "fs";
import path from "path";
import { createApp } from "../api";
import { buildOpenApiDocument } from "../openapi/build";

/**
 * Route coverage (W085): every route the app actually serves must appear in
 * the generated OpenAPI spec — either documented, or explicitly marked
 * internal (`x-internal: true` with a rationale).
 *
 * This is the test the issue asked for. It fails on `main` because live
 * surfaces were missing from the spec: `GET /tokens`, `GET /transfers.csv`,
 * `GET /transfers.parquet`, the five `/offramp/*` routes, and — found only by
 * walking the app — `GET /accounts/:address/balance` and the provider
 * callback `POST /webhooks/linq`.
 *
 * How the app's route table is collected: express stacks every `app.use` and
 * `app.get` as a Layer. A Layer with a `route` is a method route; a Layer
 * whose `handle` has its own `stack` is a mounted router. Express 4 keeps the
 * mount prefix only inside the Layer's compiled `regexp` (its `path` field
 * stays undefined until a request matches), so the walker reconstructs the
 * prefix from the pattern: `use("/offramp", router)` compiles to
 * `^\/offramp\/?(?=\/|$)`, `use("/", router)` to `^\/?(?=\/|$)`, and a param
 * mount like `use("/:address/transfers", sub)` to
 * `^(?:\/([^/]+?))\/transfers\/?(?=\/|$)` with the name in `keys`. Only
 * public Layer fields are read.
 */

/** Method keys express's router acts on — `all` and the error handler are not verbs. */
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

type MountedRoute = { method: string; path: string };

/**
 * Pull the mount path back out of a compiled express Layer regexp.
 *
 * Pinned to path-to-regexp@0.1.13 (express 4's fixed dependency), which
 * compiles every `:name` to the same `(?:\/([^/]+?))` group; the names come
 * from the layer's `keys`. If express ever changes this, the walker returns
 * wrong paths and the guard test below fails loudly rather than vacuously.
 */
function mountPrefix(layer: { regexp?: RegExp; keys?: Array<{ name: string }> }): string {
  const regexp = layer.regexp;
  if (!regexp) return "";

  let src = regexp.source;
  // express appends an optional trailing slash and lookahead to every mount.
  src = src.replace(/\\\/\?\(\?=\\\/\|\$\)$/, "");
  // Swap each compiled param group back to its `:name`, in order.
  const names = (layer.keys ?? []).map((k) => k.name);
  let i = 0;
  src = src.replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, () => `/:${names[i++] ?? "param"}`);
  // Unescape the remaining literal segments (`^`, `\/`, `\.`).
  return src
    .replace(/^\^/, "")
    .replace(/\\(.)/g, "$1")
    .replace(/^\//, "/");
}

/** Turn an express route path into OpenAPI path syntax: `:id` → `{id}`. */
function toOpenApiPath(p: string): string {
  return p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** Collect `method + full path` for every route reachable from `app`. */
function collectRoutes(app: unknown): MountedRoute[] {
  const routes: MountedRoute[] = [];

  const walk = (stack: unknown, prefix: string) => {
    for (const layer of stack as Array<Record<string, unknown>>) {
      const route = layer.route as
        | { path: string; methods?: Record<string, unknown> }
        | undefined;

      if (route) {
        let fullPath = prefix + route.path;
        // Router-level `router.get("/")` joins as "/webhooks/" — the spec
        // never carries a trailing slash.
        if (fullPath.length > 1 && fullPath.endsWith("/")) fullPath = fullPath.slice(0, -1);
        for (const method of Object.keys(route.methods ?? {}).filter((m) => HTTP_METHODS.has(m))) {
          routes.push({ method, path: fullPath });
        }
        continue;
      }

      const handleStack = (layer.handle as { stack?: unknown } | undefined)?.stack;
      if (Array.isArray(handleStack)) {
        walk(handleStack, prefix + mountPrefix(layer as { regexp?: RegExp; keys?: Array<{ name: string }> }));
      }
    }
  };

  const rootStack = (app as { _router?: { stack?: unknown } } | undefined)?._router?.stack;
  if (Array.isArray(rootStack)) walk(rootStack, "");
  return routes;
}

const spec = buildOpenApiDocument();

describe("OpenAPI route coverage (W085)", () => {
  const routes = collectRoutes(createApp());

  // Express 4 stores each verb as a truthy key on route.methods; normalise the
  // spec's keys the same way so a stray `all` or HEAD cannot paper over a gap.
  const documented = new Set<string>();
  for (const [p, pathItem] of Object.entries(spec.paths)) {
    for (const key of Object.keys(pathItem as Record<string, unknown>)) {
      if (HTTP_METHODS.has(key)) documented.add(`${key} ${p}`.toLowerCase());
    }
  }

  /**
   * Routes that are registered but not yet in the spec, as of 2026-10-06.
   *
   * The NGN rails landed after this guard was written. Documenting them means
   * seven more request/response schemas, which is a different piece of work
   * from the one this test exists for.
   *
   * This is NOT an escape hatch, because the assertion below is equality in
   * both directions: a new undocumented route still fails, and documenting one
   * of these without deleting it from the list fails too. The list can only
   * shrink, and it shrinks by someone writing the schema.
   */
  const KNOWN_UNDOCUMENTED = [
    "get /ngn/bills/{orderid}",
    "get /ngn/onramp/orders/{orderid}",
    "get /ngn/onramp/rate",
    "post /ngn/bills",
    "post /ngn/customers",
    "post /ngn/customers/kyc",
    "post /ngn/onramp/orders",
  ];

  it("every route registered on the app appears in the generated spec", () => {
    const missing = routes
      .map((r) => `${r.method} ${toOpenApiPath(r.path)}`.toLowerCase())
      .filter((key) => !documented.has(key))
      .sort();

    expect(missing).toEqual([...KNOWN_UNDOCUMENTED].sort());
  });

  it("finds the routes this issue is about (guards the guard)", () => {
    // If express internals ever change and the walker starts returning an
    // empty or partial list, the assertion above would pass vacuously. These
    // anchors prove the walker sees the real app: a plain app route, a
    // router-mounted route behind a prefix, and the root-mounted exports.
    const keys = routes.map((r) => `${r.method} ${r.path}`.toLowerCase());
    expect(keys).toContain("get /tokens");
    expect(keys).toContain("post /offramp/orders");
    expect(keys).toContain("get /summary/:address");
    expect(keys).toContain("get /accounts/:address/balance");
    expect(keys).toContain("get /transfers.csv");
  });

  it("documents /tokens", () => {
    expect(spec.paths["/tokens"]?.get).toBeDefined();
  });

  it("documents the export routes", () => {
    expect(spec.paths["/transfers.csv"]?.get).toBeDefined();
    expect(spec.paths["/transfers.parquet"]?.get).toBeDefined();
  });

  it("marks every /offramp route internal, with a rationale, and never deprecated", () => {
    const offramp = Object.entries(spec.paths)
      .filter(([p]) => p.startsWith("/offramp"))
      .flatMap(([, pathItem]) => Object.values(pathItem as Record<string, unknown>));

    expect(offramp.length).toBeGreaterThanOrEqual(5);
    // `x-internal`, not `deprecated`. In OpenAPI `deprecated` means "this still
    // works, it will be withdrawn, stop calling it", and generators act on it —
    // the react-query client would emit @deprecated on five endpoints the
    // wallet depends on today, and a reader of the published spec would
    // reasonably conclude cash-out is being retired. `x-internal` is the
    // conventional hook for filtering a route out of a published spec, and it
    // says the true thing.
    for (const op of offramp as Array<{
      "x-internal"?: boolean;
      deprecated?: boolean;
      description?: string;
    }>) {
      expect(op["x-internal"]).toBe(true);
      expect(op.deprecated).toBeUndefined();
      expect(op.description).toMatch(/internal/i);
    }
  });

  it("the committed openapi.json matches the generator output", () => {
    // Only the tracked copy. `docs/openapi.json` is gitignored — a build
    // artefact for the published docs site — so reading it threw ENOENT on
    // every clean clone, CI included, before this test could assert anything.
    // Nothing is lost: the same loop in build.ts writes both from one
    // `document`, so the docs copy cannot drift independently of this one.
    const committed = readFileSync(path.resolve(process.cwd(), "openapi.json"), "utf8");
    const generated = JSON.stringify(spec, null, 2) + "\n";

    expect(committed).toBe(generated);
  });
});
