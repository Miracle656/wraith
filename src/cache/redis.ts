import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Redis } from "ioredis";

/**
 * Opt-in Redis response cache.
 *
 * The hot read endpoints (`/assets/popular`, `/search`) re-run the same handful
 * of queries thousands of times an hour for identical query strings. A small
 * Redis layer with a per-route TTL collapses those into a single cache hit.
 *
 * Caching is **off by default**. Set `CACHE_ENABLED=true` (and optionally
 * `REDIS_URL`) to turn it on. When disabled — or when Redis is unreachable — the
 * middleware degrades to a transparent pass-through so the API never depends on
 * the cache being up.
 *
 * Clients can force a fresh response with the `X-No-Cache` header: the cached
 * value is ignored on read but the fresh response is still written back, so the
 * next caller benefits.
 */

// ── Minimal client surface ────────────────────────────────────────────────────
// We only use these three commands, so the cache (and its tests) depend on this
// narrow interface rather than the full ioredis type.
export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface CacheConfig {
  enabled: boolean;
  redisUrl: string;
  /** Prefix applied to every key, namespacing this app's entries. */
  keyPrefix: string;
}

export function cacheConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CacheConfig {
  return {
    enabled: env.CACHE_ENABLED === "true" || env.CACHE_ENABLED === "1",
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    keyPrefix: env.CACHE_KEY_PREFIX ?? "wraith:cache:",
  };
}

// ── Lazy singleton client ─────────────────────────────────────────────────────

let sharedClient: CacheClient | null = null;

/**
 * Returns the process-wide Redis client, constructing it on first use. Returns
 * `null` when caching is disabled so callers can cheaply skip all cache work.
 *
 * `ioredis` is imported lazily so environments that never enable caching don't
 * pay the connection/setup cost (and tests can run without it installed).
 */
export function getCacheClient(config: CacheConfig = cacheConfigFromEnv()): CacheClient | null {
  if (!config.enabled) return null;
  if (sharedClient) return sharedClient;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const IORedis = require("ioredis") as { default?: new (url: string) => Redis } & (new (url: string) => Redis);
  const Ctor = IORedis.default ?? IORedis;
  const redis = new Ctor(config.redisUrl);
  // A failed connection must never crash the process — log once and let the
  // middleware's try/catch fall through to the origin handler.
  redis.on("error", (err: Error) => {
    console.error("[cache] redis error:", err.message);
  });
  sharedClient = redis as unknown as CacheClient;
  return sharedClient;
}

/** Test seam: inject a fake client (or reset with `null`). */
export function setCacheClient(client: CacheClient | null): void {
  sharedClient = client;
}

// ── Cache primitive ───────────────────────────────────────────────────────────

export class RedisCache {
  constructor(
    private readonly client: CacheClient,
    private readonly keyPrefix = "wraith:cache:",
  ) {}

  private prefixed(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(this.prefixed(key));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A corrupt/foreign value behaves like a miss rather than throwing.
      return null;
    }
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    await this.client.set(this.prefixed(key), JSON.stringify(value), "PX", ttlMs);
  }

  async del(key: string): Promise<void> {
    await this.client.del(this.prefixed(key));
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────

export interface CacheMiddlewareOptions {
  /** Time-to-live for this route's entries, in milliseconds. */
  ttlMs: number;
  /**
   * Derives a cache key from the request. Defaults to method + path + a stable,
   * sorted serialization of the query string.
   */
  keyFn?: (req: Request) => string;
  /** Inject a client/config (primarily for tests). */
  client?: CacheClient | null;
  config?: CacheConfig;
}

const HEADER_NO_CACHE = "x-no-cache";
const HEADER_CACHE_STATUS = "X-Cache";

/** Stable key: sorts query params so `?a=1&b=2` and `?b=2&a=1` collide. */
export function defaultKeyFn(req: Request): string {
  const entries = Object.entries(req.query as Record<string, unknown>)
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const qs = entries.map(([k, v]) => `${k}=${v}`).join("&");
  return `${req.method}:${req.baseUrl}${req.path}?${qs}`;
}

/**
 * Returns an Express middleware that caches JSON responses for a single route.
 *
 * - On a hit, replies from Redis and sets `X-Cache: HIT`.
 * - On a miss, runs the handler, captures the `res.json(...)` body, writes it
 *   back with the route's TTL, and sets `X-Cache: MISS`.
 * - With the `X-No-Cache` request header, skips the read but still refreshes the
 *   stored value (`X-Cache: BYPASS`).
 * - When caching is disabled or Redis errors, passes straight through.
 *
 * Only successful (2xx) JSON responses are stored.
 */
export function cacheMiddleware(options: CacheMiddlewareOptions): RequestHandler {
  const config = options.config ?? cacheConfigFromEnv();
  const keyFn = options.keyFn ?? defaultKeyFn;

  return async function cache(req: Request, res: Response, next: NextFunction): Promise<void> {
    const client = options.client !== undefined ? options.client : getCacheClient(config);
    if (!client) {
      next();
      return;
    }

    const store = new RedisCache(client, config.keyPrefix);
    const key = keyFn(req);
    const bypassRead = req.header(HEADER_NO_CACHE) !== undefined;

    if (!bypassRead) {
      try {
        const hit = await store.get<unknown>(key);
        if (hit !== null) {
          res.setHeader(HEADER_CACHE_STATUS, "HIT");
          res.json(hit);
          return;
        }
      } catch (err) {
        // Read failure → treat as a miss and fall through to the origin.
        console.error("[cache] read failed:", (err as Error).message);
      }
    }

    // Wrap res.json so we can capture the payload on the way out.
    const originalJson = res.json.bind(res);
    res.json = (body: unknown): Response => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Fire-and-forget: a write failure must not delay or break the response.
        store.set(key, body, options.ttlMs).catch((err: Error) => {
          console.error("[cache] write failed:", err.message);
        });
      }
      return originalJson(body);
    };

    res.setHeader(HEADER_CACHE_STATUS, bypassRead ? "BYPASS" : "MISS");
    next();
  };
}
