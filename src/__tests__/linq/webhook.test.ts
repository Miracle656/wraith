/**
 * The webhook endpoint is public and its events assert that money moved, so
 * the signature is the only thing standing between a stranger and marking an
 * order settled. These tests pin the failure side, not the happy path.
 */
import {
  computeSignature,
  verifySignature,
  parseEvent,
} from "../../linq/webhook";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({
  event: "order.completed",
  orderId: "3f7c1b2a-84e9-4c11-b3d2-0a9f7e123456",
  amountStableCoin: 50,
  amountNGN: 82750,
});

describe("Linq webhook signatures", () => {
  it("matches the sha256=<hex> shape Linq documents", () => {
    expect(computeSignature(BODY, SECRET)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("accepts a body signed with the right secret", () => {
    expect(verifySignature(BODY, computeSignature(BODY, SECRET), SECRET)).toBe(true);
  });

  it("rejects a body altered after signing", () => {
    const signature = computeSignature(BODY, SECRET);
    const tampered = BODY.replace('"amountNGN":82750', '"amountNGN":8275000');
    expect(verifySignature(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(verifySignature(BODY, computeSignature(BODY, "wrong"), SECRET)).toBe(false);
  });

  it("rejects a missing signature rather than trusting the body", () => {
    expect(verifySignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifySignature(BODY, "", SECRET)).toBe(false);
  });

  it("rejects when no secret is configured, instead of accepting everything", () => {
    // A misconfigured deployment must fail closed: an empty secret would
    // otherwise make every forged signature verify against another empty one.
    expect(verifySignature(BODY, computeSignature(BODY, ""), "")).toBe(false);
  });

  it("returns false rather than throwing on a wrong-length signature", () => {
    // timingSafeEqual throws on unequal lengths; unguarded that turns a
    // malformed signature into a 500 and tells the sender the shape was wrong.
    expect(() => verifySignature(BODY, "sha256=abc", SECRET)).not.toThrow();
    expect(verifySignature(BODY, "sha256=abc", SECRET)).toBe(false);
  });

  it("verifies over raw bytes, so re-serialised JSON no longer matches", () => {
    // The reason this route cannot sit behind express.json(): parsing and
    // re-serialising changes the bytes even when the value is identical.
    const signature = computeSignature(BODY, SECRET);
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verifySignature(reserialised, signature, SECRET)).toBe(false);
  });
});

describe("Linq webhook parsing", () => {
  it("accepts the three documented events", () => {
    for (const event of ["order.processing", "order.completed", "order.failed"]) {
      expect(parseEvent(JSON.stringify({ event, orderId: "x" }))?.event).toBe(event);
    }
  });

  it("rejects an unknown event type", () => {
    expect(parseEvent(JSON.stringify({ event: "order.refunded", orderId: "x" }))).toBeNull();
  });

  it("rejects a body with no orderId, which nothing could be reconciled against", () => {
    expect(parseEvent(JSON.stringify({ event: "order.completed" }))).toBeNull();
  });

  it("returns null rather than throwing on malformed JSON", () => {
    expect(parseEvent("not json")).toBeNull();
    expect(parseEvent("")).toBeNull();
  });
});
