import { describe, it, expect, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import ReorgHandler from "../../src/ingest/reorg";

process.env.DATABASE_URL ??= "postgresql://wraith:wraith@localhost:55432/wraith_test";
process.env.DIRECT_DATABASE_URL ??= "postgresql://wraith:wraith@localhost:55432/wraith_test";

const prisma = new PrismaClient();

beforeEach(async () => {
  await prisma.tokenTransfer.deleteMany();
  await prisma.indexerState.deleteMany();
});

describe("automatic reorg rollback", () => {
  it("detects parent-hash mismatch, removes orphaned rows, and re-ingests canonical branch", async () => {
    // Seed original canonical branch: ledger 100 and ledger 101 (original)
    await prisma.tokenTransfer.createMany({
      data: [
        {
          contractId: "C1",
          eventType: "transfer",
          fromAddress: "A",
          toAddress: "B",
          amount: "10000000",
          ledger: 100,
          ledgerClosedAt: new Date(),
          txHash: "tx100",
          eventId: "evt-100",
        },
        {
          contractId: "C1",
          eventType: "transfer",
          fromAddress: "A",
          toAddress: "C",
          amount: "20000000",
          ledger: 101,
          ledgerClosedAt: new Date(),
          txHash: "tx101",
          eventId: "evt-101",
        },
      ],
    });

    await prisma.indexerState.create({ data: { id: 1, lastIndexedLedger: 101 } });

    // Build in-memory buffer reflecting observed ledgers
    const reorg = new ReorgHandler(16);
    reorg.record({ sequence: 100, hash: "H100", parentHash: "H99", closedAt: new Date() });
    reorg.record({ sequence: 101, hash: "H101", parentHash: "H100", closedAt: new Date() });

    // Incoming ledger 101 on a different fork that points to H100 (so H101 is orphaned)
    const incoming = { sequence: 101, hash: "H101_alt", parentHash: "H100", closedAt: new Date() };

    // Provide a reingest function that inserts the canonical ledger rows for 101
    async function reingestFn(from: number, to: number) {
      for (let seq = from; seq <= to; seq++) {
        // For the test, insert a replacement row for ledger 101
        await prisma.tokenTransfer.create({
          data: {
            contractId: "C1",
            eventType: "transfer",
            fromAddress: "A",
            toAddress: "D",
            amount: "30000000",
            ledger: seq,
            ledgerClosedAt: new Date(),
            txHash: `tx${seq}_alt`,
            eventId: `evt-${seq}-alt`,
          },
        });
      }
    }

    const result = await reorg.handleLedger(incoming as any, reingestFn);

    // Verify the original orphaned row for ledger 101 was removed and replaced
    const rows101 = await prisma.tokenTransfer.findMany({ where: { ledger: 101 } });
    expect(rows101).toHaveLength(1);
    expect(rows101[0].eventId).toBe("evt-101-alt");

    // Verify ledger 100 row still exists
    const rows100 = await prisma.tokenTransfer.findMany({ where: { ledger: 100 } });
    expect(rows100).toHaveLength(1);
    expect(rows100[0].eventId).toBe("evt-100");

    // Verify indexer state updated to 101
    const state = await prisma.indexerState.findUnique({ where: { id: 1 } });
    expect(state?.lastIndexedLedger).toBe(101);

    expect((result as any).action).toBe("reorg");
  });
});
