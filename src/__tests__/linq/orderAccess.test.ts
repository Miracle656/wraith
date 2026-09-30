/**
 * An order id and its token are the only things between a stranger and someone's
 * bank payout details, so these pin the format and the entropy, not just that
 * the functions run.
 */
import type { Request } from "express";
import {
  bearerToken,
  generateAccessToken,
  generateOrderId,
  hashAccessToken,
  isOrderId,
  issueOrderCredentials,
  tokenMatches,
} from "../../linq/orderAccess";

const reqWith = (authorization?: string) =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as Request;

describe("order ids", () => {
  it("are ofr_ followed by 22 url-safe characters", () => {
    expect(generateOrderId()).toMatch(/^ofr_[A-Za-z0-9_-]{22}$/);
  });

  it("carry 128 bits of randomness", () => {
    const raw = Buffer.from(generateOrderId().slice("ofr_".length), "base64url");
    expect(raw.length).toBe(16);
  });

  it("do not repeat", () => {
    const ids = new Set(Array.from({ length: 5000 }, generateOrderId));
    expect(ids.size).toBe(5000);
  });

  it("are recognised by isOrderId, and nothing else is", () => {
    expect(isOrderId(generateOrderId())).toBe(true);
    expect(isOrderId("3f7c1b2a-84e9-4c11-b3d2-0a9f7e123456")).toBe(false);
    expect(isOrderId("ofr_short")).toBe(false);
    expect(isOrderId(`${generateOrderId()}x`)).toBe(false);
    expect(isOrderId(undefined)).toBe(false);
    expect(isOrderId(42)).toBe(false);
  });
});

describe("access tokens", () => {
  it("are oft_ followed by 43 url-safe characters, 256 bits", () => {
    const token = generateAccessToken();
    expect(token).toMatch(/^oft_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token.slice("oft_".length), "base64url").length).toBe(32);
  });

  it("are stored as a hash that is not the token", () => {
    const { token, tokenHash } = issueOrderCredentials();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toBe(hashAccessToken(token));
  });

  it("match only their own hash", () => {
    const a = issueOrderCredentials();
    const b = issueOrderCredentials();
    expect(tokenMatches(a.token, a.tokenHash)).toBe(true);
    expect(tokenMatches(a.token, b.tokenHash)).toBe(false);
  });

  it("never match a row that has no hash", () => {
    const { token } = issueOrderCredentials();
    expect(tokenMatches(token, null)).toBe(false);
    expect(tokenMatches(token, undefined)).toBe(false);
    expect(tokenMatches(token, "")).toBe(false);
  });
});

describe("bearerToken", () => {
  const token = generateAccessToken();

  it("reads a well-formed Authorization header", () => {
    expect(bearerToken(reqWith(`Bearer ${token}`))).toBe(token);
    expect(bearerToken(reqWith(`bearer ${token}`))).toBe(token);
  });

  it("is null when the header is missing, another scheme, or not a token we issue", () => {
    expect(bearerToken(reqWith())).toBeNull();
    expect(bearerToken(reqWith(`Basic ${token}`))).toBeNull();
    expect(bearerToken(reqWith("Bearer"))).toBeNull();
    expect(bearerToken(reqWith("Bearer not-a-token"))).toBeNull();
    expect(bearerToken(reqWith(`Bearer ${token} extra`))).toBeNull();
  });
});
