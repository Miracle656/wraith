import { describe, expect, it } from "vitest";
import {
  ALICE,
  BOB,
  CONTRACT_A,
  CONTRACT_B,
  MULTI_EVENT_TX_HASH,
} from "./fixtures";

const API_BASE_URL = process.env.INTEGRATION_API_URL ?? "http://localhost:3300";

async function getJson(path: string) {
  const response = await fetch(`${API_BASE_URL}${path}`);
  const body = await response.json();

  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}

describe("Wraith integration API", () => {
  it("returns filtered incoming transfers from Postgres", async () => {
    const body = await getJson(
      `/transfers/incoming/${ALICE}?contractId=${CONTRACT_A}&eventType=transfer,mint`
    );

    expect(body.total).toBe(2);
    expect(body.transfers.map((transfer: { eventId: string }) => transfer.eventId)).toEqual([
      "integration-002",
      "integration-001",
    ]);
    expect(body.transfers[0]).toMatchObject({
      contractId: CONTRACT_A,
      toAddress: ALICE,
      displayAmount: "2.5000000",
    });
  });

  it("returns combined account history with directions and pagination", async () => {
    const body = await getJson(`/transfers/address/${ALICE}?limit=3&offset=1`);

    expect(body.total).toBe(5);
    expect(body.limit).toBe(3);
    expect(body.offset).toBe(1);
    expect(body.transfers).toHaveLength(3);
    expect(body.transfers.map((transfer: { direction: string }) => transfer.direction)).toEqual([
      "incoming",
      "outgoing",
      "incoming",
    ]);
  });

  it("aggregates account summary across incoming and outgoing events", async () => {
    const body = await getJson(`/accounts/${ALICE}/summary`);

    expect(body.address).toBe(ALICE);
    expect(body.tokens).toEqual([
      {
        contractId: CONTRACT_A,
        totalReceived: "35000000",
        totalSent: "5000000",
        netFlow: "30000000",
        displayTotalReceived: "3.5000000",
        displayTotalSent: "0.5000000",
        displayNetFlow: "3.0000000",
        txCount: 3,
      },
      {
        contractId: CONTRACT_B,
        totalReceived: "40000000",
        totalSent: "15000000",
        netFlow: "25000000",
        displayTotalReceived: "4.0000000",
        displayTotalSent: "1.5000000",
        displayNetFlow: "2.5000000",
        txCount: 2,
      },
    ]);
  });

  it("returns all token events for a transaction hash", async () => {
    const body = await getJson(`/transfers/tx/${MULTI_EVENT_TX_HASH}`);

    expect(body.transfers).toHaveLength(2);
    expect(body.transfers.map((transfer: { contractId: string }) => transfer.contractId)).toEqual([
      CONTRACT_B,
      CONTRACT_B,
    ]);
  });

  it("excludes unrelated account activity from account-specific results", async () => {
    const body = await getJson(`/transfers/outgoing/${BOB}`);

    expect(body.total).toBe(2);
    expect(body.transfers.map((transfer: { toAddress: string }) => transfer.toAddress)).toEqual([
      "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWWHF",
      ALICE,
    ]);
  });
});
