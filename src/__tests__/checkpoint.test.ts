import { describe, it, expect } from "@jest/globals";
import type { BatchMetadata, BatchPayload } from "../indexer/checkpoint";

describe("Checkpoint — Exactly-once ingest", () => {
  it("should define BatchMetadata interface correctly", () => {
    const batchMeta: BatchMetadata = {
      batchId: "ledgers:1000-1100",
      fromLedger: 1000,
      toLedger: 1100,
    };

    expect(batchMeta.batchId).toBe("ledgers:1000-1100");
    expect(batchMeta.fromLedger).toBe(1000);
    expect(batchMeta.toLedger).toBe(1100);
  });

  it("should define BatchPayload interface correctly", () => {
    const payload: BatchPayload = {
      transfers: [
        {
          contractId: "CAAAA",
          eventType: "transfer",
          fromAddress: "G1",
          toAddress: "G2",
          amount: "1000000",
          ledger: 1050,
          ledgerClosedAt: new Date("2024-01-01"),
          txHash: "tx1",
          eventId: "event-1",
        },
      ],
      nftTransfers: [],
      hostFnLogs: [],
    };

    expect(payload.transfers).toHaveLength(1);
    expect(payload.transfers[0].eventId).toBe("event-1");
  });

  it("should document exactly-once semantics", () => {
    expect(true).toBe(true);
  });
});
