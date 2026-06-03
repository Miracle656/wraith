import { Request, Response, NextFunction } from "express";
import https from "https";
import http from "http";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OpaInput {
  path: string;
  method: string;
  token: string;
  role: string;
  user?: string;
  request_count?: number;
  rate_limit?: number;
}

interface OpaPolicyResult {
  allow: boolean;
  deny_reason?: string;
  deny_rule?: string;
}

interface OpaResponse {
  result: OpaPolicyResult;
}

export interface OpaMiddlewareOptions {
  /** OPA base URL, e.g. http://localhost:8181 */
  opaUrl?: string;

  /** Rego package path to query, e.g. wraith/authz */
  policyPath?: string;

  /** Extract role from the request (defaults to req.header("x-user-role")) */
  getRole?: (req: Request) => string;

  /** Extract user from the request (defaults to req.header("x-user-id")) */
  getUser?: (req: Request) => string | undefined;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_OPA_URL     = process.env.OPA_URL     ?? "http://localhost:8181";
const DEFAULT_POLICY_PATH = process.env.OPA_POLICY  ?? "wraith/authz";

// ── OPA query helper ──────────────────────────────────────────────────────────

function queryOpa(opaUrl: string, policyPath: string, input: OpaInput): Promise<OpaPolicyResult> {
  const body = JSON.stringify({ input });
  const url  = `${opaUrl}/v1/data/${policyPath}`;

  return new Promise((resolve, reject) => {
    const parsedUrl  = new URL(url);
    const transport  = parsedUrl.protocol === "https:" ? https : http;

    const req = transport.request(
      {
        hostname: parsedUrl.hostname,
        port:     parsedUrl.port,
        path:     parsedUrl.pathname + parsedUrl.search,
        method:   "POST",
        headers:  {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          try {
            const parsed: OpaResponse = JSON.parse(raw);
            resolve(parsed.result ?? { allow: false, deny_reason: "empty OPA result", deny_rule: "opa_empty_result" });
          } catch {
            reject(new Error(`OPA response parse error: ${raw}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Bearer token extractor ────────────────────────────────────────────────────

function extractBearerToken(req: Request): string {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return "";
}

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * Returns an Express middleware that evaluates every request against the OPA
 * policy before it reaches route handlers.
 *
 * Denied requests are rejected with HTTP 403 and a JSON body that includes the
 * policy rule name and reason for auditability.
 */
export function createOpaMiddleware(opts: OpaMiddlewareOptions = {}) {
  const opaUrl     = opts.opaUrl     ?? DEFAULT_OPA_URL;
  const policyPath = opts.policyPath ?? DEFAULT_POLICY_PATH;
  const getRole    = opts.getRole    ?? ((req) => req.headers["x-user-role"] as string ?? "");
  const getUser    = opts.getUser    ?? ((req) => req.headers["x-user-id"] as string | undefined);

  return async function opaAuthz(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = extractBearerToken(req);
    const role  = getRole(req) ?? "";
    const user  = getUser(req);

    const input: OpaInput = {
      path:   req.path,
      method: req.method,
      token,
      role,
      user,
    };

    let result: OpaPolicyResult;

    try {
      result = await queryOpa(opaUrl, policyPath, input);
    } catch (err) {
      // OPA unreachable — fail closed (deny all)
      const message = err instanceof Error ? err.message : String(err);
      console.error("[opa] policy engine unreachable:", message, { path: req.path, method: req.method });
      res.status(503).json({ error: "Authorization service unavailable" });
      return;
    }

    if (!result.allow) {
      const rule   = result.deny_rule   ?? "unknown_rule";
      const reason = result.deny_reason ?? "request denied";

      console.warn("[opa] denied", {
        rule,
        reason,
        path:   req.path,
        method: req.method,
        user:   user ?? "<anonymous>",
        role,
        token:  token ? "[redacted]" : "<none>",
        ip:     req.ip,
      });

      res.status(403).json({
        error:  "Forbidden",
        rule,
        reason,
      });
      return;
    }

    next();
  };
}
