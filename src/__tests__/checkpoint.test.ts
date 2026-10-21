/**
 * Behavioural tests for src/indexer/checkpoint.ts
 *
 * NOTE: commitBatch / hasCheckpoint are not yet wired into startIndexer().
 * They are tested here in isolation so the exactly-once ingest logic is
 * exercised before the wiring lands.
 */

// ── Mock ../db before importing the module under test ──────────────────────
// prisma.$transaction must execute the callback synchronously so we can
// inspect the tx calls that happen inside it.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateManyFn: jest.Mock = jest.fn<any, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockUpsertFn: jest.Mock = jest.fn<any, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFindUniqueFn: jest.Mock = jest.fn<any, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFindFirstFn: jest.Mock = jest.fn<any, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockUpsertAccountSummariesFn: jest.Mock = jest.fn<any, any>();

// The tx object handed to the $transaction callback mirrors the real Prisma
// interactive-transaction client.
const txMock = {
  tokenTransfer: { createMany: mockCreateManyFn },
  nftTransfer: { createMany: mockCreateManyFn },
  hostFnLog: { createMany: mockCreateManyFn },
  indexerCheckpoint: { upsert: mockUpsertFn },
};

jest.mock("../db", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: jest.fn<any, any>((cb: (tx: typeof txMock) => Promise<unknown>) =>
      cb(txMock)
    ),
    indexerCheckpoint: {
      findUnique: mockFindUniqueFn,
      findFirst: mockFindFirstFn,
    },
  },
  upsertAccountSummaries: mockUpsertAccountSummariesFn,
}));

// Import after mocks are in place.
import {
  hasCheckpoint,
  getLastCheckpoint,
  commitBatch,
  updateAccountSummaries,
  type BatchMetadata,
  type BatchPayload,
} from "../indexer/checkpoint";
import { prisma } from "../db";

// ── Shared fixtures ────────────────────────────────────────────────────────

const META: BatchMetadata = {
  batchId: "sac:6000-7000",
  fromLedger: 6000,
  toLedger: 7000,
};

const EMPTY_PAYLOAD: BatchPayload = {
  transfers: [],
  nftTransfers: [],
  hostFnLogs: [],
};

const TRANSFER_PAYLOAD: BatchPayload = {
  transfers: [
    {
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      eventType: "transfer",
      fromAddress: "GBOB",
      toAddress: "GALICE",
      amount: "1000000",
      ledger: 6500,
      ledgerClosedAt: new Date("2025-01-01T00:00:00Z"),
      txHash: "txhash-abc",
      eventId: "evt-001",
    },
  ],
  nftTransfers: [],
  hostFnLogs: [],
};

const NFT_PAYLOAD: BatchPayload = {
  transfers: [],
  nftTransfers: [
    {
      contractId: "CNFT001",
      tokenId: "42",
      fromAddress: "GBOB",
      toAddress: "GALICE",
      ledger: 6500,
      ledgerClosedAt: new Date("2025-01-01T00:00:00Z"),
      txHash: "txhash-nft",
      eventId: "evt-nft-001",
    },
  ],
  hostFnLogs: [],
};

const HOSTFN_PAYLOAD: BatchPayload = {
  transfers: [],
  nftTransfers: [],
  hostFnLogs: [
    {
      contractId: "CHOSTFN001",
      functionName: "transfer",
      args: ["GBOB", "GALICE", "1000000"],
      result: null,
      gasUsed: null,
      ledger: 6500,
      ledgerClosedAt: new Date("2025-01-01T00:00:00Z"),
      txHash: "txhash-hostfn",
      eventId: "evt-hostfn-001",
    },
  ],
};

// ── hasCheckpoint ──────────────────────────────────────────────────────────

describe("hasCheckpoint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns false when no checkpoint row exists for the batchId", async () => {
    mockFindUniqueFn.mockResolvedValue(null);

    const result = await hasCheckpoint("sac:6000-7000");

    expect(result).toBe(false);
    expect(mockFindUniqueFn).toHaveBeenCalledWith({
      where: { network_batchId: { network: "testnet", batchId: "sac:6000-7000" } },
      select: { id: true },
    });
  });

  it("returns true when a checkpoint row already exists for the batchId", async () => {
    mockFindUniqueFn.mockResolvedValue({ id: 42 });

    const result = await hasCheckpoint("sac:6000-7000");

    expect(result).toBe(true);
  });

  it("scopes the lookup to the supplied network", async () => {
    mockFindUniqueFn.mockResolvedValue(null);

    await hasCheckpoint("sac:6000-7000", "mainnet");

    expect(mockFindUniqueFn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { network_batchId: { network: "mainnet", batchId: "sac:6000-7000" } },
      })
    );
  });
});

// ── getLastCheckpoint ──────────────────────────────────────────────────────

describe("getLastCheckpoint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns null when no checkpoints exist", async () => {
    mockFindFirstFn.mockResolvedValue(null);

    const result = await getLastCheckpoint();

    expect(result).toBeNull();
  });

  it("returns the highest lastLedger across all checkpoints", async () => {
    mockFindFirstFn.mockResolvedValue({ lastLedger: 7000 });

    const result = await getLastCheckpoint();

    expect(result).toBe(7000);
  });

  it("scopes the query to the supplied network", async () => {
    mockFindFirstFn.mockResolvedValue({ lastLedger: 51000 });

    const result = await getLastCheckpoint("mainnet");

    expect(result).toBe(51000);
    expect(mockFindFirstFn).toHaveBeenCalledWith(
      expect.objectContaining({ where: { network: "mainnet" } })
    );
  });
});

// ── commitBatch — fresh batch ──────────────────────────────────────────────

describe("commitBatch — fresh batch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Re-wire $transaction to run the callback (clearAllMocks resets the impl).
    (prisma.$transaction as jest.Mock).mockImplementation(
      (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock)
    );
    mockCreateManyFn.mockResolvedValue({ count: 1 });
    mockUpsertFn.mockResolvedValue({});
  });

  it("runs inside a transaction", async () => {
    await commitBatch(META, EMPTY_PAYLOAD);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("upserts the checkpoint with the correct batchId and toLedger", async () => {
    await commitBatch(META, TRANSFER_PAYLOAD);

    expect(mockUpsertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { network_batchId: { network: "testnet", batchId: META.batchId } },
        create: expect.objectContaining({
          batchId: META.batchId,
          lastLedger: META.toLedger,
          network: "testnet",
        }),
        update: expect.objectContaining({
          lastLedger: META.toLedger,
        }),
      })
    );
  });

  it("inserts token transfers and returns the inserted count", async () => {
    mockCreateManyFn.mockResolvedValue({ count: 1 });

    const result = await commitBatch(META, TRANSFER_PAYLOAD);

    expect(result.transferred).toBe(1);
  });

  it("stamps the network column on every transfer row", async () => {
    await commitBatch(META, TRANSFER_PAYLOAD);

    // mockCreateManyFn is shared across all createMany calls; token transfers
    // are the first call since TRANSFER_PAYLOAD has one transfer and no NFTs.
    const firstCallArgs = mockCreateManyFn.mock.calls[0][0] as {
      data: Array<{ network: string }>;
      skipDuplicates: boolean;
    };
    expect(firstCallArgs.data[0].network).toBe("testnet");
  });

  it("skips createMany calls when the payload arrays are empty", async () => {
    await commitBatch(META, EMPTY_PAYLOAD);

    // createMany should never be called for empty arrays
    expect(mockCreateManyFn).not.toHaveBeenCalled();
    // but the checkpoint upsert still fires
    expect(mockUpsertFn).toHaveBeenCalledTimes(1);
  });

  it("uses the supplied network rather than the env default", async () => {
    await commitBatch(META, EMPTY_PAYLOAD, "mainnet");

    expect(mockUpsertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { network_batchId: { network: "mainnet", batchId: META.batchId } },
      })
    );
  });

  it("inserts NFT transfers and returns the nftTransferred count", async () => {
    mockCreateManyFn.mockResolvedValue({ count: 1 });

    const result = await commitBatch(META, NFT_PAYLOAD);

    expect(result.nftTransferred).toBe(1);
    expect(mockCreateManyFn).toHaveBeenCalledTimes(1);
  });

  it("inserts host-function logs and returns the hostFnLogs count", async () => {
    mockCreateManyFn.mockResolvedValue({ count: 1 });

    const result = await commitBatch(META, HOSTFN_PAYLOAD);

    expect(result.hostFnLogs).toBe(1);
    expect(mockCreateManyFn).toHaveBeenCalledTimes(1);
  });
});

// ── commitBatch — replayed batchId is a no-op ──────────────────────────────

describe("commitBatch — replayed batchId", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.$transaction as jest.Mock).mockImplementation(
      (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock)
    );
    mockCreateManyFn.mockResolvedValue({ count: 0 }); // skipDuplicates dedupes
    mockUpsertFn.mockResolvedValue({});
  });

  it("returns zero counts when all transfers are already present (skipDuplicates)", async () => {
    const result = await commitBatch(META, TRANSFER_PAYLOAD);

    // The transaction still runs and the checkpoint is updated.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockUpsertFn).toHaveBeenCalledTimes(1);
    // But no net new rows land.
    expect(result.transferred).toBe(0);
  });
});

// ── commitBatch — failed insert rolls back checkpoint ─────────────────────

describe("commitBatch — transaction failure", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("propagates the error when the transaction rejects", async () => {
    // Make $transaction itself reject, simulating a DB connection loss that
    // causes the entire transaction (including the checkpoint upsert) to roll back.
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(
      new Error("DB connection lost")
    );

    await expect(commitBatch(META, TRANSFER_PAYLOAD)).rejects.toThrow(
      "DB connection lost"
    );
  });

  it("does not call the checkpoint upsert when createMany throws inside the tx", async () => {
    // Simulate failure mid-transaction: createMany throws before upsert is reached.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failingCreateMany: jest.Mock = jest.fn<any, any>().mockRejectedValue(
      new Error("insert error")
    );
    const failingTx = {
      tokenTransfer: { createMany: failingCreateMany },
      nftTransfer: { createMany: failingCreateMany },
      hostFnLog: { createMany: failingCreateMany },
      indexerCheckpoint: { upsert: mockUpsertFn },
    };

    (prisma.$transaction as jest.Mock).mockImplementationOnce(
      (cb: (tx: typeof failingTx) => Promise<unknown>) => cb(failingTx)
    );

    await expect(commitBatch(META, TRANSFER_PAYLOAD)).rejects.toThrow("insert error");

    // The real $transaction would roll back; our mock simply never reached upsert.
    expect(mockUpsertFn).not.toHaveBeenCalled();
  });
});

// ── updateAccountSummaries ─────────────────────────────────────────────────

describe("updateAccountSummaries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpsertAccountSummariesFn.mockResolvedValue(undefined);
  });

  it("delegates to upsertAccountSummaries with the resolved network", async () => {
    await updateAccountSummaries(TRANSFER_PAYLOAD.transfers, "testnet");

    expect(mockUpsertAccountSummariesFn).toHaveBeenCalledWith(
      TRANSFER_PAYLOAD.transfers,
      "testnet"
    );
  });

  it("defaults to testnet when no network is passed", async () => {
    await updateAccountSummaries(TRANSFER_PAYLOAD.transfers);

    expect(mockUpsertAccountSummariesFn).toHaveBeenCalledWith(
      TRANSFER_PAYLOAD.transfers,
      "testnet"
    );
  });
});
