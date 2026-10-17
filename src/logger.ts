import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Structured logging for Veil.
 *
 * One JSON object per line. Every line has a level and an event, and when
 * a request is in flight it also carries the request id so a support report
 * can be traced end to end across the API and the provider boundary.
 *
 * Deliberate omissions: NIN, API keys, connection strings and account
 * numbers must never appear in a log line. The `redact` pass below is the
 * safety net: every field is screened before it is serialised, and the
 * `safeDetails` helper makes it hard to accidentally pass through a raw
 * provider response.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface LogLine extends LogFields {
  timestamp: string;
  level: LogLevel;
  event: string;
  requestId?: string;
  route?: string;
  status?: number;
  durationMs?: number;
}

/**
 * Patterns that must never reach a log line. These are deliberately
 * broad and conservative: false positives are acceptable, leaking a
 * NIN or a connection string is not.
 */
const SECRET_PATTERNS: RegExp[] = [
  // 11-digit Nigerian identity number.
  /\b(?:\d{11})\b/,
  // Postgres / MySQL / Mongo / Redis connection strings.
  /\b(?:abcdefghijklmnopqrstuvwxyz{})?:(?:\/\/))[^\s]+/,
  // Bearer / API key style tokens.
  /\bBearer\s+[A-Za-z0-9_\-.]{16,}/i,
  /\b(?:sk|rk|pk|api)[_-][A-Za-z0-9]{16,}/i,
  // JWT-like three-part tokens.
  /\beyJ[a-zA-Z0-9_\-.]+\.eyJ[a-zA-Z0-9_\-.]+\.[a-zA-Z0-9_\-.]+\b/,
];

const REDACTED_VALUE = '[REDACTED]';

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED_VALUE);
  }
  return out;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 6) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [i, v] of Object.entries(value as Record<string, unknown>)) {
      out[i] = redactValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Request context. A request id is stashed here by the requestId middleware
 * and read by the logger, so every line emitted while a request is in flight
 * carries the same id - including lines emitted from the provider client.
 */
const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

function write(level: LogLevel, event: string, fields: LogFields = {}): LogLine {
  const requestId = getRequestId();
  const line: LogLine = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(requestId ? { requestId } : {}),
    ...((redactValue(fields) as LogFields) ?? {}),
  };
  const serialised = JSON.stringify(line);
  if (level === 'error') {
    console.error(serialised);
  } else if (level === 'warn') {
    console.warn(serialised);
  } else {
    console.log(serialised);
  }
  return line;
}

export const logger = {
  debug: (event: string, fields?: LogFields) => write('debug', event, fields),
  info: (event: string, fields?: LogFields) => write('info', event, fields),
  warn: (event: string, fields?: LogFields) => write('warn', event, fields),
  error: (event: string, fields?: LogFields) => write('error', event, fields),
};

/**
 * Log one provider call. This is the single choke point the acceptance
 * criteria care about: every provider call must emit exactly one line
 * with route, status and elapsed ms.
 */
export function logProviderCall(input: {
  route: string;
  status: number;
  durationMs: number;
  event?: string;
  extra?: LogFields;
}): LogLine {
  const { route, status, durationMs, event = 'provider.call', extra } = input;
  const level: LogLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  return write(level, event, {
    route,
    status,
    durationMs,
    ...(extra ?? {}),
  });
}

/**
 * Take a provider response body and return only the fields that are safe to
 * log. This is the easy way to stay careful: callers never hand the raw
 * body to the logger, they pass it through here first.
 */
export function safeDetails(body: unknown, keys: string[] = []): LogFields {
  if (!body || typeof body !== 'object') return {};
  const source = body as Record<string, unknown>;
  const out: LogFields = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = redactValue(source[key]);
    }
  }
  return out;
}

export const _internal = { redactValue, redactString, SECRET_PATTERNS };
