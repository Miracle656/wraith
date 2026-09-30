/**
 * Seed script — inserts deterministic test data
 *
 * Inserts deterministic TokenTransfer, NftTransfer, and AccountSummary rows
 * for testing and development. Safe to run multiple times: uses skipDuplicates
 * on unique constraints so rows are never duplicated.
 *
 * Usage:
 *   npx ts-node scripts/seed.ts
 *   npx ts-node scripts/seed.ts --network mainnet
 *
 * Environment variables:
 *   DATABASE_URL          — Postgres connection string (required)
 */

import "dotenv/config";
import { prisma } from "../src/db";
import {
  tokenTransferFixtures,
  nftTransferFixtures,
  accountSummaryFixtures,
} from "../src/fixtures";
import { resolveNetwork, type Network } from "../src/network";

function parseArgs(): { network: Network } {
  const args = process.argv.slice(2);
  const networkFlag = args.find((arg) => arg.startsWith("--network="));
  const networkValue = networkFlag
    ? networkFlag.split("=")[1]
    : process.env.STELLAR_NETWORK || "testnet";

  if (networkValue !== "testnet" && networkValue !== "mainnet") {
    console.error(`Invalid network: "${networkValue}". Valid values: testnet, mainnet.`);
    process.exit(1);
  }

  return { network: networkValue as Network };
}

async function main() {
  const { network } = parseArgs();
  console.log(`[seed] Seeding database for network: ${network}`);

  const networkName = resolveNetwork(network);

  // Insert token transfers
  const tokenResult = await prisma.tokenTransfer.createMany({
    data: tokenTransferFixtures.map((r) => ({ ...r, network: networkName })),
    skipDuplicates: true,
  });
  console.log(`[seed] Inserted ${tokenResult.count} token transfer rows`);

  // Insert NFT transfers
  const nftResult = await prisma.nftTransfer.createMany({
    data: nftTransferFixtures.map((r) => ({ ...r, network: networkName })),
    skipDuplicates: true,
  });
  console.log(`[seed] Inserted ${nftResult.count} NFT transfer rows`);

  // Insert account summaries
  const summaryResult = await prisma.accountSummary.createMany({
    data: accountSummaryFixtures.map((r) => ({ ...r, network: networkName })),
    skipDuplicates: true,
  });
  console.log(`[seed] Inserted ${summaryResult.count} account summary rows`);

  console.log(`[seed] Done. Seeded ${network} with deterministic fixtures.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[seed] Fatal error:", err);
  process.exit(1);
});
