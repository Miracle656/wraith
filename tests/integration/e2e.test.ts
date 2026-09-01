/**
 * End-to-end ingest → query test (#74).
 *
 * Requires a live DATABASE_URL (set via .env or CI docker-compose service).
 * The suite is skipped automatically when DATABASE_URL is absent so the unit
 * test suite continues to pass without a database.
 *
 * Flow:
 *   1. Insert a pre-recorded transfer fixture directly via Prisma
 *      (simulating what the indexer writes after decoding an RPC event).
 *   2. Query GET /transfers/incoming/:address via the Express app.
 *   3. Assert the fixture row appears in the response.
 *   4. Clean up the inserted row so the test is idempotent.
 */

import request from "supertest";
import { createApp } from "../../src/api";
import { prisma } from "../../src/db";
import fixture from "./fixtures/horizon-event.json";

const HAS_DB = !!process.env.DATABASE_URL;

// Skip every test in this suite when no DB is available.
const describeE2E = HAS_DB ? describe : describe.skip;

describeE2E("E2E: ingest → query (#74)", () => {
  beforeAll(async () => {
    // Ensure the row does not already exist from a prior interrupted run
    await prisma.tokenTransfer.deleteMany({
      where: { eventId: fixture.eventId },
    });

    // Insert fixture as if the indexer had processed a real horizon event
    await prisma.tokenTransfer.create({
      data: {
        contractId:      fixture.contractId,
        eventType:       fixture.eventType,
        fromAddress:     fixture.fromAddress,
        toAddress:       fixture.toAddress,
        amount:          fixture.amount,
        ledger:          fixture.ledger,
        ledgerClosedAt:  new Date(fixture.ledgerClosedAt),
        txHash:          fixture.txHash,
        eventId:         fixture.eventId,
      },
    });
  });

  afterAll(async () => {
    await prisma.tokenTransfer.deleteMany({
      where: { eventId: fixture.eventId },
    });
    await prisma.$disconnect();
  });

  it("GET /transfers/incoming/:address returns the indexed row", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/transfers/incoming/${fixture.toAddress}`)
      .query({ contractId: fixture.contractId });

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);

    const row = (res.body.transfers as Array<Record<string, unknown>>).find(
      t => t["eventId"] === fixture.eventId,
    );
    expect(row).toBeDefined();
    expect(row!["eventType"]).toBe("transfer");
    expect(row!["fromAddress"]).toBe(fixture.fromAddress);
    expect(row!["toAddress"]).toBe(fixture.toAddress);
    expect(row!["amount"]).toBe(fixture.amount);
    expect(row!["contractId"]).toBe(fixture.contractId);
    expect(row!["txHash"]).toBe(fixture.txHash);
  });

  it("GET /transfers/outgoing/:address returns the indexed row", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/transfers/outgoing/${fixture.fromAddress}`)
      .query({ contractId: fixture.contractId });

    expect(res.status).toBe(200);

    const row = (res.body.transfers as Array<Record<string, unknown>>).find(
      t => t["eventId"] === fixture.eventId,
    );
    expect(row).toBeDefined();
    expect(row!["fromAddress"]).toBe(fixture.fromAddress);
  });

  it("GET /transfers/tx/:txHash returns the indexed row", async () => {
    const app = createApp();
    const res = await request(app).get(`/transfers/tx/${fixture.txHash}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.transfers)).toBe(true);
    expect(
      (res.body.transfers as Array<Record<string, unknown>>).some(
        t => t["eventId"] === fixture.eventId,
      ),
    ).toBe(true);
  });
});
