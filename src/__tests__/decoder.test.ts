import { xdr } from "@stellar/stellar-sdk";
import { parseEvent } from "../decoder";
import * as fixtures from "./fixtures/events.json";

describe("Soroban XDR Decoder", () => {
  const common = {
    ledger: 100,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    contractId: fixtures.contractId,
    txHash: "abc123txhash",
    id: "0000000000000000001-00001",
    type: "contract",
  };

  it("correctly parses a 'transfer' event", () => {
    const raw = {
      ...common,
      topic: fixtures.transfer.topic.map((t) => xdr.ScVal.fromXDR(t, "base64")),
      value: xdr.ScVal.fromXDR(fixtures.transfer.value, "base64"),
    };

    const result = parseEvent(raw);
    expect(result).not.toBeNull();
    expect(result?.eventType).toBe("transfer");
    expect(result?.fromAddress).toBe(fixtures.alice);
    expect(result?.toAddress).toBe(fixtures.bob);
    expect(result?.amount).toBe("1000000000");
  });

  it("correctly parses a 'mint' event", () => {
    const raw = {
      ...common,
      topic: fixtures.mint.topic.map((t) => xdr.ScVal.fromXDR(t, "base64")),
      value: xdr.ScVal.fromXDR(fixtures.mint.value, "base64"),
    };

    const result = parseEvent(raw);
    expect(result).not.toBeNull();
    expect(result?.eventType).toBe("mint");
    expect(result?.fromAddress).toBeNull(); // mint has no from for our purposes
    expect(result?.toAddress).toBe(fixtures.bob);
    expect(result?.amount).toBe("5000000000");
  });

  it("correctly parses a 'burn' event", () => {
    const raw = {
      ...common,
      topic: fixtures.burn.topic.map((t) => xdr.ScVal.fromXDR(t, "base64")),
      value: xdr.ScVal.fromXDR(fixtures.burn.value, "base64"),
    };

    const result = parseEvent(raw);
    expect(result).not.toBeNull();
    expect(result?.eventType).toBe("burn");
    expect(result?.fromAddress).toBe(fixtures.alice);
    expect(result?.toAddress).toBeNull();
    expect(result?.amount).toBe("100");
  });

  it("correctly parses a 'clawback' event", () => {
    const raw = {
      ...common,
      topic: fixtures.clawback.topic.map((t) => xdr.ScVal.fromXDR(t, "base64")),
      value: xdr.ScVal.fromXDR(fixtures.clawback.value, "base64"),
    };

    const result = parseEvent(raw);
    expect(result).not.toBeNull();
    expect(result?.eventType).toBe("clawback");
    expect(result?.fromAddress).toBe(fixtures.alice);
    expect(result?.toAddress).toBeNull();
    expect(result?.amount).toBe("200");
  });

  it("throws on malformed XDR topics", () => {
    const raw = {
      ...common,
      topic: fixtures.transfer.topic.slice(0, 1).map((t) => xdr.ScVal.fromXDR(t, "base64")), // Missing topics
      value: xdr.ScVal.fromXDR(fixtures.transfer.value, "base64"),
    };

    expect(() => parseEvent(raw)).toThrow(/Malformed transfer event/);
  });

  it("throws on invalid ScVal type in topics", () => {
    const raw = {
      ...common,
      topic: [
        xdr.ScVal.fromXDR(fixtures.transfer.topic[0], "base64"),
        xdr.ScVal.scvVoid(), // Invalid address type
        xdr.ScVal.scvVoid(),
      ],
      value: xdr.ScVal.fromXDR(fixtures.transfer.value, "base64"),
    };

    expect(() => parseEvent(raw)).toThrow();
  });

  it("returns null for non-token events", () => {
    const raw = {
      ...common,
      topic: [xdr.ScVal.scvSymbol("something_else")],
      value: xdr.ScVal.scvVoid(),
    };

    const result = parseEvent(raw);
    expect(result).toBeNull();
  });
});
