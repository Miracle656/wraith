import type { Prisma } from "@prisma/client";

export const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
export const CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM";

export const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
export const BOB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWWHF";
export const CAROL = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWWHF";

export const MULTI_EVENT_TX_HASH = "txhash-integration-multi";

type SeedTransfer = Prisma.TokenTransferCreateManyInput;

const at = (iso: string) => new Date(iso);

export const seedTransfers: SeedTransfer[] = [
  {
    contractId: CONTRACT_A,
    eventType: "transfer",
    fromAddress: BOB,
    toAddress: ALICE,
    amount: "10000000",
    ledger: 2001,
    ledgerClosedAt: at("2025-01-01T00:00:00Z"),
    txHash: "tx-incoming-a-1",
    eventId: "integration-001",
  },
  {
    contractId: CONTRACT_A,
    eventType: "mint",
    fromAddress: null,
    toAddress: ALICE,
    amount: "25000000",
    ledger: 2002,
    ledgerClosedAt: at("2025-01-02T00:00:00Z"),
    txHash: "tx-mint-a-1",
    eventId: "integration-002",
  },
  {
    contractId: CONTRACT_A,
    eventType: "transfer",
    fromAddress: ALICE,
    toAddress: BOB,
    amount: "5000000",
    ledger: 2003,
    ledgerClosedAt: at("2025-01-03T00:00:00Z"),
    txHash: "tx-outgoing-a-1",
    eventId: "integration-003",
  },
  {
    contractId: CONTRACT_B,
    eventType: "transfer",
    fromAddress: CAROL,
    toAddress: ALICE,
    amount: "40000000",
    ledger: 2004,
    ledgerClosedAt: at("2025-02-01T00:00:00Z"),
    txHash: MULTI_EVENT_TX_HASH,
    eventId: "integration-004",
  },
  {
    contractId: CONTRACT_B,
    eventType: "clawback",
    fromAddress: ALICE,
    toAddress: null,
    amount: "15000000",
    ledger: 2005,
    ledgerClosedAt: at("2025-02-02T00:00:00Z"),
    txHash: MULTI_EVENT_TX_HASH,
    eventId: "integration-005",
  },
  {
    contractId: CONTRACT_A,
    eventType: "transfer",
    fromAddress: BOB,
    toAddress: CAROL,
    amount: "999000000",
    ledger: 2006,
    ledgerClosedAt: at("2025-03-01T00:00:00Z"),
    txHash: "tx-unrelated",
    eventId: "integration-006",
  },
];
