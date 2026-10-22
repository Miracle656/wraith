/**
 * ─── CORS, decided per surface ──────────────────────────────────────────────
 *
 * This file exists because one line in `src/api.ts` — `app.use(cors())` — was
 * answering every request with `Access-Control-Allow-Origin: *`, whatever the
 * request was for. The `cors` package with no options allows every origin, so
 * that single line covered five surfaces that have nothing in common:
 *
 *   - the public read API (transfers, NFTs, accounts, search, exports),
 *   - the GraphQL endpoint,
 *   - the fee quote,
 *   - the offramp, and
 *   - the naira rails.
 *
 * For the read API `*` is the right answer and it stays: the data is public
 * chain data, and an indexer nobody can read is not an indexer. For the
 * routes that create orders it was never a decision — it was the default that
 * came with the line, and nobody chose it. This file makes it one.
 *
 * ── The surfaces ────────────────────────────────────────────────────────────
 *
 * | Surface           | Routes                                       | Policy      |
 * | ----------------- | -------------------------------------------- | ----------- |
 * | read API          | every read not listed below                  | open        |
 * | GraphQL           | `GET`/`POST /graphql`                        | open        |
 * | fee quote         | `GET /fees`                                  | open        |
 * | offramp quotes    | `GET /offramp/rate`, `/availability`         | open        |
 * | offramp orders    | `/offramp/orders*`, `/verify-bank`, `/trustline` | allow-list |
 * | naira rails       | `/ngn/*`                                     | allow-list  |
 * | webhook admin     | `/webhooks` (not `/webhooks/linq`)            | allow-list  |
 * | provider callback | `POST /webhooks/linq`                        | server      |
 * | metrics           | `GET /metrics`                               | allow-list  |
 * | any other write   | a write nobody has classified yet            | allow-list  |
 *
 * Why each one is what it is:
 *
 * - **read API — open.** Chain data is public by definition, and a browser
 *   dashboard on any domain is the intended consumer. Nothing here is personal
 *   and nothing here costs money, so there is nothing to protect.
 * - **GraphQL — open.** The schema has a `Query` type and no `Mutation`
 *   (`src/graphql/server.ts`), so a POST here is a read that happens to be
 *   spelled as a query. It reads the same public data as the REST routes.
 * - **fee quote — open.** `GET /fees` is unauthenticated by design (it
 *   carries no personal data, and a stale fee is one a user was shown but did
 *   not agree to) and the mobile app has to be able to read it.
 * - **offramp quotes — open.** The availability flag and the rate are the
 *   same kind of thing as the fee quote: a price, no personal data, no state.
 * - **offramp orders — allow-list.** `POST /offramp/orders` creates a real
 *   payout at the provider against the business account, and
 *   `POST /offramp/verify-bank` spends provider quota on somebody else's
 *   behalf. These are the routes the ticket is about.
 * - **naira rails — allow-list.** `/ngn/*` provisions customers, submits a
 *   NIN for KYC, buys naira and pays bills. The whole surface is restricted
 *   rather than split, because the KYC routes carry a national identity
 *   number and the rate route sits on the same host as the ones that do.
 * - **webhook admin — allow-list.** `POST /webhooks` makes this server POST
 *   to an address of the caller's choosing and `DELETE /webhooks/:id` tears a
 *   subscription down. Neither is a thing a page on an arbitrary site should
 *   be able to do.
 * - **provider callback — server.** `POST /webhooks/linq` is the payout
 *   provider calling *us*. It is authenticated by an HMAC signature over the
 *   raw body (`src/api/linqWebhook.ts`), so a browser can neither forge it nor
 *   read anything useful. It gets no CORS headers at all — a browser cannot
 *   read the response — and, deliberately, it is never *refused* here: a
 *   payment rail must not stop working because someone tightened this policy.
 * - **metrics — allow-list.** `/metrics` is for a scraper, not for a page.
 *   A scrape sends no `Origin`, so it is unaffected.
 * - **any other write — allow-list.** The two catch-alls at the bottom of the
 *   table are the important ones. A read is open unless a rule says otherwise,
 *   because a read is the public API; a write is restricted unless a rule says
 *   otherwise, because a write is the thing that costs money. The next route
 *   someone adds is therefore restricted by default and has to be classified
 *   on purpose — which is the whole point of the change.
 *
 * ── Configuring the allow-list ──────────────────────────────────────────────
 *
 * `CORS_ALLOWED_ORIGINS` is a comma-separated list of origins:
 *
 * ```
 * CORS_ALLOWED_ORIGINS=https://wallet.example.com,https://app.example.com
 * ```
 *
 * A new client is an environment change, not a code change: adding an origin
 * here means an operator edits one variable and redeploys, and no file in
 * this repository is touched. Origins are matched exactly after normalisation
 * (`https://example.com/` and `https://example.com` are the same origin);
 * there is no wildcard, because `*.example.com` is a rule about a domain and
 * this is a rule about an origin, and one day they are not the same thing.
 *
 * An empty list means no browser origin may call an allow-listed surface. That
 * is the safe default and it is not a no-op: the mobile app is unaffected
 * (it sends no `Origin`), but a browser client has to be added to the list
 * before it can reach the offramp or the naira rails.
 *
 * ── What an allow-listed surface does with a request ────────────────────────
 *
 *  - **No `Origin` header at all → the request is served.** A native client
 *    (the mobile app), a server-to-server caller and `curl` all send none.
 *    CORS is a browser mechanism; a request that did not come from a browser
 *    cannot be constrained by one, and pretending otherwise would break
 *    every installed APK.
 *  - **`Origin` on the allow-list → the request is served**, and the response
 *    carries `Access-Control-Allow-Origin: <that origin>` plus
 *    `Vary: Origin`. The origin is reflected rather than answered with `*`
 *    so a shared cache cannot hand one origin's response to another.
 *  - **`Origin` not on the allow-list → `403` with `origin_not_allowed`.**
 *    Not merely "no CORS headers": with headers omitted the browser would
 *    still have *sent* the request, and `POST /offramp/orders` would still
 *    have created a payout that the caller never saw. Refusing is what
 *    actually answers "who may call this from a browser".
 *
 * One caveat, because it is the difference between this being a control and
 * this being a habit: **CORS is not authentication.** A server-to-server
 * client can call any of these routes whatever this file says, and the
 * allow-list only says which *browsers* may. The routes that move money
 * still need their own authorisation — the offramp order lookup already
 * carries a bearer token, and `/ngn` still relies on the order/reference
 * pairing — and this policy is not a substitute for any of it.
 */

import type { RequestHandler, Response } from "express";
import cors from "cors";

/**
 * What a browser is allowed to do on one surface.
 *
 * - `open` — any origin may call it; the response says `*`.
 * - `allowlist` — only an origin on `CORS_ALLOWED_ORIGINS` may call it.
 * - `server` — not a browser surface: no CORS headers, and never refused.
 */
export type CorsPolicy = "open" | "allowlist" | "server";

/** The code a refused origin is answered with. */
export const ORIGIN_NOT_ALLOWED = "origin_not_allowed";

interface CorsRule {
  /** Name of the surface. Reported when an origin is refused. */
  surface: string;
  /** Path prefix this rule owns. */
  path: string;
  /** HTTP methods this rule covers. */
  methods: "*" | readonly string[];
  /** What a browser on this surface may do. */
  policy: CorsPolicy;
}

/**
 * The surfaces, in the order they are matched. The first match wins, so the
 * specific rules come before the two catch-alls at the bottom.
 *
 * The last rule is the important one: a write nobody has classified is
 * restricted, so a new route cannot become a browser-reachable one by
 * accident.
 */
const CORS_RULES: readonly CorsRule[] = [
  // The provider's callback. Not a browser surface — see the module header.
  { surface: "linq-callback", path: "/webhooks/linq", methods: "*", policy: "server" },
  // Subscription management: makes us POST to a caller's URL, deletes one.
  { surface: "webhook-admin", path: "/webhooks", methods: "*", policy: "allowlist" },
  // The naira rails: customer provisioning, KYC, buying naira, paying bills.
  { surface: "ngn-rails", path: "/ngn", methods: "*", policy: "allowlist" },
  // The offramp: real payouts, provider quota, provider configuration.
  { surface: "offramp-orders", path: "/offramp/orders", methods: "*", policy: "allowlist" },
  { surface: "offramp-verify-bank", path: "/offramp/verify-bank", methods: "*", policy: "allowlist" },
  { surface: "offramp-trustline", path: "/offramp/trustline", methods: "*", policy: "allowlist" },
  // A scraper, not a page.
  { surface: "metrics", path: "/metrics", methods: "*", policy: "allowlist" },
  // Read-only schema: a POST here is a query, not a mutation.
  { surface: "graphql", path: "/graphql", methods: "*", policy: "open" },
  // Prices, not state.
  { surface: "offramp-quote", path: "/offramp/rate", methods: ["GET", "HEAD"], policy: "open" },
  { surface: "offramp-quote", path: "/offramp/availability", methods: ["GET", "HEAD"], policy: "open" },
  // The public read API.
  { surface: "read-api", path: "/", methods: ["GET", "HEAD", "OPTIONS"], policy: "open" },
  // Everything else is a write nobody has classified: restricted until it is.
  { surface: "unclassified-write", path: "/", methods: "*", policy: "allowlist" },
];

/**
 * Does a path fall under a rule's prefix?
 *
 * Segment-aware on purpose: `/offramp/orders` must not claim
 * `/offramp/ordersomething`, and `/offramp` must not claim `/offrampfoo`.
 */
function pathMatches(rulePath: string, path: string): boolean {
  if (rulePath === "/") return true;
  return path === rulePath || path.startsWith(`${rulePath}/`);
}

/**
 * The policy that governs one request.
 *
 * Exported so a test — and the next person — can ask what the answer is for a
 * given path and method without sending a request.
 */
export function corsPolicyFor(path: string, method: string): { surface: string; policy: CorsPolicy } {
  const verb = method.toUpperCase();
  for (const rule of CORS_RULES) {
    if (!pathMatches(rule.path, path)) continue;
    if (rule.methods !== "*" && !rule.methods.includes(verb)) continue;
    return { surface: rule.surface, policy: rule.policy };
  }
  // Unreachable: the last rule matches every path and every method.
  return { surface: "unclassified-write", policy: "allowlist" };
}

/**
 * Normalise an origin so two spellings of the same origin compare equal.
 *
 * `new URL` gives the canonical form — lower-cased scheme and host, no
 * trailing slash, no path. It throws on the literal `null` origin, which a
 * sandboxed frame sends and which is therefore kept as-is: allow-listing it
 * is a decision somebody has to make on purpose.
 */
function normaliseOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

/**
 * Read the allow-list out of a comma-separated environment value.
 *
 * Empty entries are dropped, duplicates collapse, and every entry is
 * normalised, so `CORS_ALLOWED_ORIGINS=https://a.example, https://a.example/`
 * is one origin rather than two.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const origins: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const normalised = normaliseOrigin(trimmed);
    if (!origins.includes(normalised)) origins.push(normalised);
  }
  return origins;
}

/**
 * The allow-list this deployment runs with.
 *
 * Read from the environment every time it is asked for, so a test — or a
 * process that rewrites its own environment — sees the current value rather
 * than the one that was set when the module was first imported.
 */
export function allowedOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
}

/** Is this origin on the allow-list? */
export function isOriginAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.includes(normaliseOrigin(origin));
}

/**
 * Refuse a request from an origin that is not on the allow-list.
 *
 * The body is the same `{ error, code }` shape the rails answer with, so a
 * client that branches on `code` finds one it already knows how to read.
 */
function refuseOrigin(res: Response, surface: string): void {
  res.status(403).json({
    error: "This endpoint is not available to this origin.",
    code: ORIGIN_NOT_ALLOWED,
    surface,
  });
}

/**
 * The CORS middleware, with the policy for each surface applied.
 *
 * Mounted once, in `src/api.ts`, in front of every router. It decides per
 * request: which surface this is, and therefore what that surface's policy is.
 */
export function createCorsMiddleware(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const allowedOrigins = allowedOriginsFromEnv(env);

  // Any origin, and the origin is not reflected: the public read API.
  const openCors = cors({ origin: "*" });
  // Reflect the origin. Only reached after the allow-list has said yes.
  const reflectCors = cors({ origin: true });

  return function corsMiddleware(req, res, next) {
    const { surface, policy } = corsPolicyFor(req.path, req.method);

    if (policy === "server") {
      // No CORS headers, so a browser cannot read the response — and no
      // refusal, so a provider callback is never blocked by our policy.
      return next();
    }

    if (policy === "allowlist") {
      const origin = req.headers.origin;
      if (origin !== undefined && !isOriginAllowed(origin, allowedOrigins)) {
        return refuseOrigin(res, surface);
      }
      // No `Origin` header: the request is not from a browser, and CORS has
      // nothing to say about it. It is served, with no CORS headers on it.
      return reflectCors(req, res, next);
    }

    return openCors(req, res, next);
  };
}
