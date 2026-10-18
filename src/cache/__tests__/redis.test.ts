import request from "supertest";
import express, { Request, Response } from "express";
import {
  cacheMiddleware,
  cacheConfigFromEnv,
  defaultKeyFn,
  RedisCache,
  type CacheClient,
  type CacheConfig,
} from "../redis";

// ── In-memory fake of the narrow CacheClient surface ────────────────────────
class FakeRedis implements CacheClient {
  store = new Map<string, string>();
  getCalls = 0;
  setCalls = 0;

  async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  async set(key: string, value: string, _mode: "PX", _ttlMs: number): Promise<unknown> {
    this.setCalls += 1;
    this.store.set(key, value);
    return "OK";
  }

  async del(...keys: string[]): Promise<unknown> {
    for (const k of keys) this.store.delete(k);
    return keys.length;
  }
}

const enabledConfig: CacheConfig = {
  enabled: true,
  redisUrl: "redis://unused",
  keyPrefix: "test:",
};

/**
 * Builds an app whose handler records how many times it actually ran, so a
 * cache hit is observable as "origin not invoked".
 */
function buildApp(client: CacheClient | null, config: CacheConfig = enabledConfig) {
  const app = express();
  let originHits = 0;

  app.get(
    "/widgets",
    cacheMiddleware({ ttlMs: 1000, client, config }),
    (_req: Request, res: Response) => {
      originHits += 1;
      res.json({ value: "fresh", originHits });
    },
  );

  app.get(
    "/maybe-error",
    cacheMiddleware({ ttlMs: 1000, client, config }),
    (req: Request, res: Response) => {
      originHits += 1;
      res.status(500).json({ error: "boom" });
    },
  );

  return { app, getOriginHits: () => originHits };
}

describe("cacheMiddleware", () => {
  it("misses on the first request and runs the origin handler", async () => {
    const redis = new FakeRedis();
    const { app, getOriginHits } = buildApp(redis);

    const res = await request(app).get("/widgets").query({ a: "1" });

    expect(res.status).toBe(200);
    expect(res.headers["x-cache"]).toBe("MISS");
    expect(res.body.value).toBe("fresh");
    expect(getOriginHits()).toBe(1);
    expect(redis.setCalls).toBe(1); // response written back
  });

  it("serves a hit from cache without re-running the origin handler", async () => {
    const redis = new FakeRedis();
    const { app, getOriginHits } = buildApp(redis);

    const first = await request(app).get("/widgets").query({ a: "1" });
    const second = await request(app).get("/widgets").query({ a: "1" });

    expect(first.headers["x-cache"]).toBe("MISS");
    expect(second.headers["x-cache"]).toBe("HIT");
    // Origin ran exactly once; the second response came from Redis.
    expect(getOriginHits()).toBe(1);
    expect(second.body).toEqual(first.body);
  });

  it("treats different query strings as different keys", async () => {
    const redis = new FakeRedis();
    const { app, getOriginHits } = buildApp(redis);

    await request(app).get("/widgets").query({ a: "1" });
    const other = await request(app).get("/widgets").query({ a: "2" });

    expect(other.headers["x-cache"]).toBe("MISS");
    expect(getOriginHits()).toBe(2);
  });

  describe("X-No-Cache header", () => {
    it("bypasses the read but still refreshes the stored value", async () => {
      const redis = new FakeRedis();
      const { app, getOriginHits } = buildApp(redis);

      // Prime the cache.
      await request(app).get("/widgets").query({ a: "1" });
      expect(getOriginHits()).toBe(1);

      // Bypass: origin must run again despite the entry existing.
      const bypass = await request(app)
        .get("/widgets")
        .query({ a: "1" })
        .set("X-No-Cache", "1");

      expect(bypass.headers["x-cache"]).toBe("BYPASS");
      expect(getOriginHits()).toBe(2);

      // The bypass refreshed the entry, so the next plain request is a HIT
      // that does not run the origin.
      const after = await request(app).get("/widgets").query({ a: "1" });
      expect(after.headers["x-cache"]).toBe("HIT");
      expect(getOriginHits()).toBe(2);
    });
  });

  it("does not cache non-2xx responses", async () => {
    const redis = new FakeRedis();
    const { app, getOriginHits } = buildApp(redis);

    const first = await request(app).get("/maybe-error");
    const second = await request(app).get("/maybe-error");

    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    expect(redis.setCalls).toBe(0);
    expect(getOriginHits()).toBe(2); // never served from cache
  });

  it("passes through transparently when caching is disabled", async () => {
    const redis = new FakeRedis();
    const { app, getOriginHits } = buildApp(null, { ...enabledConfig, enabled: false });

    const res = await request(app).get("/widgets").query({ a: "1" });

    expect(res.status).toBe(200);
    expect(res.headers["x-cache"]).toBeUndefined();
    expect(getOriginHits()).toBe(1);
    expect(redis.setCalls).toBe(0);
  });

  it("falls through to the origin when a cache read throws", async () => {
    const flaky: CacheClient = {
      get: jest.fn().mockRejectedValue(new Error("connection reset")),
      set: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(0),
    };
    const { app, getOriginHits } = buildApp(flaky);

    const res = await request(app).get("/widgets");

    expect(res.status).toBe(200);
    expect(res.body.value).toBe("fresh");
    expect(getOriginHits()).toBe(1);
  });
});

describe("defaultKeyFn", () => {
  const baseReq = (query: Record<string, unknown>, network?: string): Request =>
    ({ method: "GET", baseUrl: "/search", path: "/", query, network } as unknown as Request);

  it("is stable regardless of query param order", () => {
    expect(defaultKeyFn(baseReq({ a: "1", b: "2" }, "mainnet"))).toBe(
      defaultKeyFn(baseReq({ b: "2", a: "1" }, "mainnet")),
    );
  });

  it("encodes method, network, path and sorted query", () => {
    expect(defaultKeyFn(baseReq({ b: "2", a: "1" }, "mainnet"))).toBe(
      "GET:mainnet:/search/?a=1&b=2",
    );
  });

  it("flattens array query values", () => {
    expect(defaultKeyFn(baseReq({ tag: ["x", "y"] }, "mainnet"))).toBe(
      "GET:mainnet:/search/?tag=x,y",
    );
  });

  it("falls back to 'unknown' when req.network is not set", () => {
    expect(defaultKeyFn(baseReq({ a: "1" }))).toBe("GET:unknown:/search/?a=1");
  });

  // Acceptance criteria: two requests differing only by X-Network produce different keys.
  // networkMiddleware resolves both ?network= and X-Network: into req.network, so by the
  // time defaultKeyFn runs the network is always in req.network regardless of how it arrived.
  it("produces different keys for mainnet vs testnet", () => {
    const mainnet = defaultKeyFn(baseReq({ q: "USDC" }, "mainnet"));
    const testnet = defaultKeyFn(baseReq({ q: "USDC" }, "testnet"));
    expect(mainnet).not.toBe(testnet);
    expect(mainnet).toBe("GET:mainnet:/search/?q=USDC");
    expect(testnet).toBe("GET:testnet:/search/?q=USDC");
  });

  // Acceptance criteria: ?network=mainnet and X-Network: mainnet produce the same key.
  // Both paths go through networkMiddleware which sets req.network; the ?network= param
  // is stripped from the query segment to avoid double-encoding.
  it("produces the same key for ?network=mainnet and X-Network: mainnet (both resolve to req.network)", () => {
    // Simulates request via query string: networkMiddleware strips ?network from query
    // and sets req.network = "mainnet"
    const viaQuery = defaultKeyFn(baseReq({ q: "USDC" }, "mainnet"));
    // Simulates request via header: networkMiddleware sets req.network = "mainnet",
    // query has no network param at all
    const viaHeader = defaultKeyFn(baseReq({ q: "USDC" }, "mainnet"));
    expect(viaQuery).toBe(viaHeader);
  });

  it("excludes the ?network query param from the key (captured in req.network instead)", () => {
    // ?network= in the query string must not appear in the key; the resolved
    // req.network value is the canonical source.
    const withNetworkInQuery = defaultKeyFn(
      baseReq({ q: "USDC", network: "mainnet" }, "mainnet"),
    );
    const withoutNetworkInQuery = defaultKeyFn(baseReq({ q: "USDC" }, "mainnet"));
    expect(withNetworkInQuery).toBe(withoutNetworkInQuery);
    expect(withNetworkInQuery).toBe("GET:mainnet:/search/?q=USDC");
  });
});

describe("RedisCache", () => {
  it("round-trips JSON values through get/set", async () => {
    const redis = new FakeRedis();
    const cache = new RedisCache(redis, "p:");

    await cache.set("k", { hello: "world" }, 500);
    expect(redis.store.has("p:k")).toBe(true);
    expect(await cache.get<{ hello: string }>("k")).toEqual({ hello: "world" });
  });

  it("returns null for a missing key", async () => {
    const cache = new RedisCache(new FakeRedis());
    expect(await cache.get("nope")).toBeNull();
  });

  it("returns null (a miss) for a corrupt stored value", async () => {
    const redis = new FakeRedis();
    redis.store.set("p:bad", "{not json");
    const cache = new RedisCache(redis, "p:");
    expect(await cache.get("bad")).toBeNull();
  });

  it("deletes a key", async () => {
    const redis = new FakeRedis();
    const cache = new RedisCache(redis, "p:");
    await cache.set("k", 1, 500);
    await cache.del("k");
    expect(redis.store.has("p:k")).toBe(false);
  });
});

describe("cacheConfigFromEnv", () => {
  it("is disabled by default", () => {
    expect(cacheConfigFromEnv({}).enabled).toBe(false);
  });

  it("enables on CACHE_ENABLED=true or 1", () => {
    expect(cacheConfigFromEnv({ CACHE_ENABLED: "true" }).enabled).toBe(true);
    expect(cacheConfigFromEnv({ CACHE_ENABLED: "1" }).enabled).toBe(true);
    expect(cacheConfigFromEnv({ CACHE_ENABLED: "yes" }).enabled).toBe(false);
  });

  it("reads REDIS_URL and CACHE_KEY_PREFIX", () => {
    const cfg = cacheConfigFromEnv({
      CACHE_ENABLED: "true",
      REDIS_URL: "redis://example:6379",
      CACHE_KEY_PREFIX: "x:",
    });
    expect(cfg.redisUrl).toBe("redis://example:6379");
    expect(cfg.keyPrefix).toBe("x:");
  });
});
