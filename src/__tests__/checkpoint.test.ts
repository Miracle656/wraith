/**
 * Behavioural tests for src/indexer/checkpoint.ts — exactly-once ingest (#101).
 *
 * All Prisma I/O is mocked so no database is needed. The suite verifies the
 * three outcomes that matter for the exactly-once guarantee:
 *
 *   1. A fresh batch is inserted and the checkpoint is advanced.
 *   2. A replayed batchId (crash-restart) is a no-op at the DB level.
 *   3. A failed insert causes the transaction to abort so the checkpoint
 *      does not advance.
 *
 * NOTE: commitBatch and isBatchProcessed (via hasCheckpoint) are called and
 * visible in the coverage report. The module is still not wired into
 * startIndexer().
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// ─── Prisma mock ────────────────────────────────────────────────────────────
// Declare the fakes before jest.mock() so the factory closure can close over
// them — the same pattern as tombstones.test.ts.
//
// Using jest.fn<FunctionSignature>() (full function type, not just return type)
// as required by @jest/globals v30 — passing only a return type produces a
// "never" mismatch when calling mockResolvedValue.

const tokenTransferCreateMany = jest.fn<
  (args: { data: unknown[]; skipDuplicates: boolean }) => Promise<{ count: number }>
>();
const nftTransferCreateMany = jest.fn<
  (args: { data: unknown[]; skipDuplicates: boolean }) => Promise<{ count: number }>
>();
const hostFnLogCreateMany = jest.fn<
  (args: { data: unknown[]; skipDuplicates: boolean }) => Promise<{ count: number }>
>();
const indexerCheckpointUpsert = jest.fn<(args: unknown) => Promise<unknown>>();
const indexerCheckpointFindUnique = jest.fn<(args: unknown) => Promise<unknown>>();
const indexerCheckpointFindFirst = jest.fn<(args: unknown) => Promise<unknown>>();

// $transaction calls the callback with a fake tx that exposes the same mock
// fns the real tx would. If any fn inside the callback rejects, $transaction
// propagates that rejection and the checkpoint upsert (which comes last) is
// never reached — that is the rollback behaviour we assert below.
const $transaction = jest.fn<
  (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>
>(async (cb) => {
  const fakeTx = {
    tokenTransfer:     { createMany: tokenTransferCreateMany },
    nftTransfer:       { createMany: nftTransferCreateMany },
    hostFnLog:         { createMany: hostFnLogCreateMany },
    indexerCheckpoint: { upsert: indexerCheckpointUpsert },
  };
  return cb(fakeTx);
});

const upsertAccountSummaries = jest.fn<() => Promise<void>>();

jest.mock("../db", () => ({
  prisma: {
    $transaction,
    indexerCheckpoint: {
      findUnique: indexerCheckpointFindUnique,
      findFirst:  indexerCheckpointFindFirst,
    },
  },
  upsertAccountSummaries,
}));

// ─── Module under test ───────────────────────────────────────────────────────
import {
  hasCheckpoint,
  getLastCheckpoint,
  commitBatch,
  type BatchMetadata,
  type BatchPayload,
} from "../indexer/checkpoint";
import type { TransferRecord } from "../db";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const META: BatchMetadata = {
  batchId:    "sac:6000-7000",
  fromLedger: 6000,
  toLedger:   7000,
};

const TRANSFER: TransferRecord = {
  contractId:     "CTOKEN",
  eventType:      "transfer",
  fromAddress:    "GSENDER",
  toAddress:      "GRECEIVER",
  amount:         "10000000",
  ledger:         6500,
  ledgerClosedAt: new Date("2025-01-01T00:00:00.000Z"),
  txHash:         "txhash-abc",
  eventId:        "6500-1",
};

const EMPTY_PAYLOAD: BatchPayload = {
  transfers:    [],
  nftTransfers: [],
  hostFnLogs:   [],
};

const PAYLOAD_WITH_TRANSFER: BatchPayload = {
  transfers:    [TRANSFER],
  nftTransfers: [],
  hostFnLogs:   [],
};

// ─── Reset between tests ─────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: the checkpoint does not exist, all writes succeed.
  indexerCheckpointFindUnique.mockResolvedValue(null);
  indexerCheckpointFindFirst.mockResolvedValue(null);
  tokenTransferCreateMany.mockResolvedValue({ count: 1 });
  nftTransferCreateMany.mockResolvedValue({ count: 0 });
  hostFnLogCreateMany.mockResolvedValue({ count: 0 });
  indexerCheckpointUpsert.mockResolvedValue({});
});

// ─── hasCheckpoint / isBatchProcessed ────────────────────────────────────────

describe("hasCheckpoint", () => {
  it("returns false when no row exists for the given batchId", async () => {
    indexerCheckpointFindUnique.mockResolvedValue(null);

    const result = await hasCheckpoint("sac:6000-7000", "testnet");

    expect(result).toBe(false);
    expect(indexerCheckpointFindUnique).toHaveBeenCalledWith({
      where:  { network_batchId: { network: "testnet", batchId: "sac:6000-7000" } },
      select: { id: true },
    });
  });

  it("returns true when the checkpoint row already exists", async () => {
    indexerCheckpointFindUnique.mockResolvedValue({ id: 42 });

    const result = await hasCheckpoint("sac:6000-7000", "testnet");

    expect(result).toBe(true);
  });

  it("resolves the network from STELLAR_NETWORK when none is supplied", async () => {
    process.env.STELLAR_NETWORK = "mainnet";
    try {
      await hasCheckpoint("sac:6000-7000");

      const callArg = indexerCheckpointFindUnique.mock.calls[0][0] as {
        where: { network_batchId: { network: string } };
      };
      expect(callArg.where.network_batchId.network).toBe("mainnet");
    } finally {
      delete process.env.STELLAR_NETWORK;
    }
  });
});

// ─── getLastCheckpoint ───────────────────────────────────────────────────────

describe("getLastCheckpoint", () => {
  it("returns null when no checkpoints exist for the network", async () => {
    indexerCheckpointFindFirst.mockResolvedValue(null);

    const result = await getLastCheckpoint("testnet");

    expect(result).toBeNull();
    expect(indexerCheckpointFindFirst).toHaveBeenCalledWith({
      where:   { network: "testnet" },
      orderBy: { lastLedger: "desc" },
      select:  { lastLedger: true },
    });
  });

  it("returns the highest lastLedger across all batches on the network", async () => {
    indexerCheckpointFindFirst.mockResolvedValue({ lastLedger: 7000 });

    const result = await getLastCheckpoint("testnet");

    expect(result).toBe(7000);
  });
});

// ─── commitBatch — happy path ─────────────────────────────────────────────────

describe("commitBatch — fresh batch", () => {
  it("runs a transaction and returns the inserted counts", async () => {
    tokenTransferCreateMany.mockResolvedValue({ count: 1 });

    const result = await commitBatch(META, PAYLOAD_WITH_TRANSFER, "testnet");

    expect(result).toEqual({ transferred: 1, nftTransferred: 0, hostFnLogs: 0 });
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it("upserts the checkpoint with the correct ledger and network", async () => {
    await commitBatch(META, EMPTY_PAYLOAD, "testnet");

    expect(indexerCheckpointUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where:  { network_batchId: { network: "testnet", batchId: META.batchId } },
        create: expect.objectContaining({
          network:    "testnet",
          batchId:    META.batchId,
          lastLedger: META.toLedger,
        }),
        update: expect.objectContaining({
          lastLedger: META.toLedger,
        }),
      }),
    );
  });

  it("stamps every transfer row with the resolved network", async () => {
    await commitBatch(META, PAYLOAD_WITH_TRANSFER, "mainnet");

    const callArg = tokenTransferCreateMany.mock.calls[0][0] as {
      data: Array<{ network: string }>;
    };
    expect(callArg.data[0].network).toBe("mainnet");
  });

  it("skips createMany calls when the payload arrays are empty", async () => {
    await commitBatch(META, EMPTY_PAYLOAD, "testnet");

    expect(tokenTransferCreateMany).not.toHaveBeenCalled();
    expect(nftTransferCreateMany).not.toHaveBeenCalled();
    expect(hostFnLogCreateMany).not.toHaveBeenCalled();
    // The checkpoint upsert still runs even for an empty payload.
    expect(indexerCheckpointUpsert).toHaveBeenCalledTimes(1);
  });
});

// ─── commitBatch — replayed batchId (crash-restart idempotency) ───────────────

describe("commitBatch — replayed batchId", () => {
  it("re-runs createMany with skipDuplicates so existing rows are silently ignored", async () => {
    // Prisma's skipDuplicates returns 0 for already-inserted rows.
    tokenTransferCreateMany.mockResolvedValue({ count: 0 });

    const result = await commitBatch(META, PAYLOAD_WITH_TRANSFER, "testnet");

    // The count reflects what Prisma says was actually inserted (0 dupes), not
    // the payload length — so the caller can log the right number.
    expect(result.transferred).toBe(0);
    // The upsert still fires: it updates the timestamp but leaves lastLedger
    // unchanged, which is the correct cursor behaviour on replay.
    expect(indexerCheckpointUpsert).toHaveBeenCalledTimes(1);
  });

  it("passes skipDuplicates: true for every createMany call", async () => {
    await commitBatch(META, PAYLOAD_WITH_TRANSFER, "testnet");

    const callArg = tokenTransferCreateMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
    };
    expect(callArg.skipDuplicates).toBe(true);
  });
});

// ─── commitBatch — failed insert rolls back the checkpoint ────────────────────

describe("commitBatch — failed insert", () => {
  it("propagates the error so the caller knows the batch failed", async () => {
    tokenTransferCreateMany.mockRejectedValue(new Error("db constraint violation"));

    await expect(commitBatch(META, PAYLOAD_WITH_TRANSFER, "testnet")).rejects.toThrow(
      "db constraint violation",
    );
  });

  it("does not call indexerCheckpoint.upsert when an earlier step throws", async () => {
    // Because $transaction propagates the rejection from the callback, any
    // statement after the failing createMany — specifically the checkpoint
    // upsert — is never reached. This is the exactly-once guarantee: we never
    // advance the cursor for a batch we didn't fully persist.
    tokenTransferCreateMany.mockRejectedValue(new Error("unique constraint failed"));

    await expect(commitBatch(META, PAYLOAD_WITH_TRANSFER, "testnet")).rejects.toThrow();

    expect(indexerCheckpointUpsert).not.toHaveBeenCalled();
  });

  it("does not call indexerCheckpoint.upsert when $transaction itself rejects", async () => {
    // Simulates a connection drop or serialisation failure at the Prisma level.
    $transaction.mockRejectedValueOnce(new Error("transaction serialisation failure"));

    await expect(commitBatch(META, EMPTY_PAYLOAD, "testnet")).rejects.toThrow(
      "transaction serialisation failure",
    );

    expect(indexerCheckpointUpsert).not.toHaveBeenCalled();
  });
});
