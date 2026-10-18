import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { Request } from "express";

/**
 * Access control for offramp orders.
 *
 * An order exposes the bank payout amount, the deposit address and the rate, so
 * reading one back needs proof of having created it. The proof is a bearer token
 * issued once, in the response that creates the order.
 */

const ORDER_ID_PREFIX = "ofr_";
const TOKEN_PREFIX = "oft_";

/** 128 bits: too many to enumerate, however fast the caller is allowed to ask. */
const ORDER_ID_BYTES = 16;
/** 256 bits. It is a credential, so it gets the full width of the hash behind it. */
const TOKEN_BYTES = 32;

// base64url of 16 bytes is 22 characters, of 32 bytes is 43.
const ORDER_ID_RE = /^ofr_[A-Za-z0-9_-]{22}$/;
const TOKEN_RE = /^oft_[A-Za-z0-9_-]{43}$/;

export interface OrderCredentials {
  /** Identifier the client looks the order up by. */
  orderId: string;
  /** Bearer token, returned to the creator once and never stored. */
  token: string;
  /** What is persisted in place of the token. */
  tokenHash: string;
}

export function generateOrderId(): string {
  return ORDER_ID_PREFIX + randomBytes(ORDER_ID_BYTES).toString("base64url");
}

export function generateAccessToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueOrderCredentials(orderId = generateOrderId()): OrderCredentials {
  const token = generateAccessToken();
  return { orderId, token, tokenHash: hashAccessToken(token) };
}

/** True only for an id this service could have issued. */
export function isOrderId(value: unknown): value is string {
  return typeof value === "string" && ORDER_ID_RE.test(value);
}

/** The token from `Authorization: Bearer <token>`, or null when absent or malformed. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  if (!match || !TOKEN_RE.test(match[1])) return null;
  return match[1];
}

// Compared against when there is no stored hash, so a lookup for an id that does
// not exist takes as long as one with the wrong token.
const ABSENT_HASH = hashAccessToken("absent");

/** Constant-time check of a presented token against the stored hash. */
export function tokenMatches(token: string, storedHash: string | null | undefined): boolean {
  const expected = Buffer.from(storedHash ?? ABSENT_HASH, "hex");
  const actual = Buffer.from(hashAccessToken(token), "hex");
  const equal = expected.length === actual.length && timingSafeEqual(expected, actual);
  return equal && !!storedHash;
}
