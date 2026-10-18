/**
 * Fixture data validation test
 *
 * Verifies that the fixture data meets the acceptance criteria:
 * - Contains deterministic data across at least two addresses and two contracts
 * - Data structure matches the expected schema
 */

import { describe, it, expect } from "@jest/globals";
import {
  tokenTransferFixtures,
  nftTransferFixtures,
  accountSummaryFixtures,
  CONTRACT_A,
  CONTRACT_B,
  ALICE,
  BOB,
  CAROL,
} from "../fixtures";

describe("fixture data validation", () => {
  it("contains at least two addresses", () => {
    const addresses = new Set(
      tokenTransferFixtures.flatMap((t) => [t.fromAddress, t.toAddress].filter(Boolean))
    );
    expect(addresses.size).toBeGreaterThanOrEqual(2);
    expect(addresses.has(ALICE)).toBe(true);
    expect(addresses.has(BOB)).toBe(true);
  });

  it("contains at least two contracts", () => {
    const contracts = new Set(tokenTransferFixtures.map((t) => t.contractId));
    expect(contracts.size).toBeGreaterThanOrEqual(2);
    expect(contracts.has(CONTRACT_A)).toBe(true);
    expect(contracts.has(CONTRACT_B)).toBe(true);
  });

  it("has valid token transfer fixture structure", () => {
    expect(tokenTransferFixtures.length).toBeGreaterThan(0);
    tokenTransferFixtures.forEach((t) => {
      expect(t).toHaveProperty("contractId");
      expect(t).toHaveProperty("eventType");
      expect(t).toHaveProperty("amount");
      expect(t).toHaveProperty("ledger");
      expect(t).toHaveProperty("ledgerClosedAt");
      expect(t).toHaveProperty("txHash");
      expect(t).toHaveProperty("eventId");
    });
  });

  it("has valid NFT transfer fixture structure", () => {
    expect(nftTransferFixtures.length).toBeGreaterThan(0);
    nftTransferFixtures.forEach((t) => {
      expect(t).toHaveProperty("contractId");
      expect(t).toHaveProperty("tokenId");
      expect(t).toHaveProperty("ledger");
      expect(t).toHaveProperty("ledgerClosedAt");
      expect(t).toHaveProperty("txHash");
      expect(t).toHaveProperty("eventId");
    });
  });

  it("has valid account summary fixture structure", () => {
    expect(accountSummaryFixtures.length).toBeGreaterThan(0);
    accountSummaryFixtures.forEach((s) => {
      expect(s).toHaveProperty("address");
      expect(s).toHaveProperty("contractId");
      expect(s).toHaveProperty("totalSent");
      expect(s).toHaveProperty("totalReceived");
      expect(s).toHaveProperty("net");
      expect(s).toHaveProperty("txCount");
      expect(s).toHaveProperty("lastActivityAt");
    });
  });

  it("account summaries match the transfer data", () => {
    // Verify that the account summary fixtures contain data for the same addresses and contracts
    const summaryAddresses = new Set(accountSummaryFixtures.map((s) => s.address));
    const summaryContracts = new Set(accountSummaryFixtures.map((s) => s.contractId));

    expect(summaryAddresses.has(ALICE)).toBe(true);
    expect(summaryAddresses.has(BOB)).toBe(true);
    expect(summaryAddresses.has(CAROL)).toBe(true);
    expect(summaryContracts.has(CONTRACT_A)).toBe(true);
    expect(summaryContracts.has(CONTRACT_B)).toBe(true);
  });
});
