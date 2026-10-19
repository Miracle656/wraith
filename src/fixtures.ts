import type { Prisma } from "@prisma/client";
import type { TransferRecord } from "./db";

export const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
export const CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM";

export const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
export const BOB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWWHF";
export const CAROL = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWWHF";

export const MULTI_EVENT_TX_HASH = "txhash-integration-multi";

const at = (iso: string) => new Date(iso);

export const tokenTransferFixtures: Prisma.TokenTransferCreateManyInput[] = [
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

export const nftTransferFixtures: Prisma.NftTransferCreateManyInput[] = [
  {
    contractId: CONTRACT_A,
    tokenId: "token-001",
    fromAddress: BOB,
    toAddress: ALICE,
    ledger: 2001,
    ledgerClosedAt: at("2025-01-01T00:00:00Z"),
    txHash: "tx-nft-incoming-a-1",
    eventId: "nft-integration-001",
  },
  {
    contractId: CONTRACT_B,
    tokenId: "token-002",
    fromAddress: CAROL,
    toAddress: ALICE,
    ledger: 2004,
    ledgerClosedAt: at("2025-02-01T00:00:00Z"),
    txHash: "tx-nft-incoming-b-1",
    eventId: "nft-integration-002",
  },
  {
    contractId: CONTRACT_A,
    tokenId: "token-003",
    fromAddress: ALICE,
    toAddress: BOB,
    ledger: 2003,
    ledgerClosedAt: at("2025-01-03T00:00:00Z"),
    txHash: "tx-nft-outgoing-a-1",
    eventId: "nft-integration-003",
  },
];

export const accountSummaryFixtures: Prisma.AccountSummaryCreateManyInput[] = [
  {
    address: ALICE,
    contractId: CONTRACT_A,
    totalSent: "5000000",
    totalReceived: "35000000",
    net: "30000000",
    txCount: 3,
    lastActivityAt: at("2025-01-03T00:00:00Z"),
  },
  {
    address: ALICE,
    contractId: CONTRACT_B,
    totalSent: "15000000",
    totalReceived: "40000000",
    net: "25000000",
    txCount: 2,
    lastActivityAt: at("2025-02-02T00:00:00Z"),
  },
  {
    address: BOB,
    contractId: CONTRACT_A,
    totalSent: "10000000",
    totalReceived: "5000000",
    net: "-5000000",
    txCount: 2,
    lastActivityAt: at("2025-03-01T00:00:00Z"),
  },
  {
    address: CAROL,
    contractId: CONTRACT_B,
    totalSent: "40000000",
    totalReceived: "0",
    net: "-40000000",
    txCount: 1,
    lastActivityAt: at("2025-02-01T00:00:00Z"),
  },
];

export const transferRecords: TransferRecord[] = tokenTransferFixtures.map((r) => ({
  contractId: r.contractId,
  eventType: r.eventType,
  fromAddress: r.fromAddress ?? null,
  toAddress: r.toAddress ?? null,
  amount: r.amount,
  ledger: r.ledger,
  ledgerClosedAt: new Date(r.ledgerClosedAt),
  txHash: r.txHash,
  eventId: r.eventId,
}));
