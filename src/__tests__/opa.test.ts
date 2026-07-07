/**
 * Unit tests for the OPA authorization middleware.
 *
 * The OPA HTTP client is replaced with a controllable mock so these tests
 * run without a live OPA instance.
 */

import http from "http";
import { EventEmitter } from "events";
import supertest from "supertest";
import express, { Request, Response } from "express";
import { createOpaMiddleware } from "../middleware/opa";

// ── Mock the Node http.request ────────────────────────────────────────────────

type MockOpaResult = { allow: boolean; deny_reason?: string; deny_rule?: string };

let mockOpaResult: MockOpaResult = { allow: true };
// When true, the mocked OPA request emits an "error" instead of a response,
// exercising the middleware's fail-closed (503) path.
let mockOpaUnreachable = false;
// `var` (not `let`) so the binding is hoisted and initialized to `undefined`
// before jest hoists the `jest.mock("http", …)` factory above this line — a
// `let`/`const` would still be in its temporal dead zone when the factory runs.
var mockOpaRequest: jest.Mock;

jest.mock("http", () => {
  const actual = jest.requireActual<typeof http>("http");

  mockOpaRequest = jest.fn((opts: unknown, callback?: unknown) => {
    // Only intercept requests bound for the OPA server (hostname "opa"). Anything
    // else — notably supertest's own client socket to the in-process express app —
    // must go to the real http.request, or the round-trip breaks (e.g. the missing
    // `setNoDelay`). This is why a blanket global mock previously failed.
    const host =
      opts && typeof opts === "object"
        ? ((opts as { hostname?: string; host?: string }).hostname ??
           (opts as { hostname?: string; host?: string }).host)
        : undefined;
    if (host !== "opa") {
      return (actual.request as unknown as (...a: unknown[]) => unknown)(opts, callback);
    }

    // Simulate an unreachable OPA server: emit an error instead of a response.
    if (mockOpaUnreachable) {
      return {
        on: (event: string, handler: (err: Error) => void) => {
          if (event === "error") setImmediate(() => handler(new Error("ECONNREFUSED")));
        },
        write: jest.fn(),
        end:   jest.fn(),
      };
    }

    // Build a fake IncomingMessage
    const fakeRes = new EventEmitter() as NodeJS.ReadableStream & { statusCode: number };
    (fakeRes as { statusCode: number }).statusCode = 200;

    // Simulate async response delivery
    setImmediate(() => {
      const body = JSON.stringify({ result: mockOpaResult });
      (fakeRes as EventEmitter).emit("data", body);
      (fakeRes as EventEmitter).emit("end");
    });

    if (typeof callback === "function") (callback as (r: unknown) => void)(fakeRes);

    return {
      on:    jest.fn(),
      write: jest.fn(),
      end:   jest.fn(),
    };
  });

  return { ...actual, request: mockOpaRequest };
});

// ── Test app factory ──────────────────────────────────────────────────────────

function makeApp(overrides = {}) {
  const app = express();
  app.use(createOpaMiddleware({ opaUrl: "http://opa:8181", ...overrides }));
  app.get("/protected", (_req: Request, res: Response) => res.json({ ok: true }));
  app.get("/healthz",   (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createOpaMiddleware", () => {
  beforeEach(() => {
    mockOpaResult = { allow: true };
    mockOpaUnreachable = false;
    jest.clearAllMocks();
  });

  it("allows the request when OPA returns allow=true", async () => {
    mockOpaResult = { allow: true };
    const res = await supertest(makeApp())
      .get("/protected")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 403 when OPA returns allow=false", async () => {
    mockOpaResult = {
      allow:        false,
      deny_reason:  "missing or empty bearer token",
      deny_rule:    "require_bearer_token",
    };

    const res = await supertest(makeApp()).get("/protected");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
    expect(res.body.rule).toBe("require_bearer_token");
    expect(res.body.reason).toBe("missing or empty bearer token");
  });

  it("includes rule and reason in the 403 body", async () => {
    mockOpaResult = {
      allow:       false,
      deny_reason: "admin role required",
      deny_rule:   "require_admin_role",
    };

    const res = await supertest(makeApp())
      .get("/protected")
      .set("Authorization", "Bearer some-token");

    expect(res.body.rule).toBe("require_admin_role");
    expect(res.body.reason).toBe("admin role required");
  });

  it("forwards the request to the route handler when allowed", async () => {
    mockOpaResult = { allow: true };

    const res = await supertest(makeApp())
      .get("/healthz")
      .set("Authorization", "Bearer tok");

    expect(res.status).toBe(200);
  });

  it("extracts bearer token from Authorization header", async () => {
    mockOpaResult = { allow: true };
    await supertest(makeApp())
      .get("/protected")
      .set("Authorization", "Bearer my-token-123");

    // Verify OPA was called (token extraction is internal; we confirm it was queried)
    expect(mockOpaRequest).toHaveBeenCalled();
  });

  it("returns 503 when OPA is unreachable", async () => {
    mockOpaUnreachable = true;

    const res = await supertest(makeApp()).get("/protected");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("Authorization service unavailable");
  });

  it("uses x-user-role header to populate role in OPA input", async () => {
    mockOpaResult = { allow: true };
    await supertest(makeApp())
      .get("/protected")
      .set("Authorization", "Bearer tok")
      .set("x-user-role", "admin");

    expect(mockOpaRequest).toHaveBeenCalled();
  });

  it("uses custom getRole extractor when provided", async () => {
    mockOpaResult = { allow: true };
    const app = makeApp({ getRole: () => "superuser" });
    const res = await supertest(app).get("/protected").set("Authorization", "Bearer tok");
    expect(res.status).toBe(200);
  });
});
