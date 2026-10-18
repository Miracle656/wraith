/**
 * Seed script — inserts deterministic test data
 *
 * Inserts deterministic TokenTransfer, NftTransfer, and AccountSummary rows
 * for testing and development. Safe to run multiple times: uses skipDuplicates
 * on unique constraints so rows are never duplicated.
 *
 * Usage:
 *   npm run db:seed
 *   npm run db:seed -- --network=mainnet
 *   npm run db:seed -- --network mainnet
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
  // Both spellings: `--network=mainnet` and `--network mainnet`. Accepting only
  // the first silently seeded testnet when the second was typed, which is the
  // worst outcome for a flag whose whole job is picking the target.
  const eq = args.find((arg) => arg.startsWith("--network="));
  const spaced = args.indexOf("--network");
  const networkValue = eq
    ? eq.slice("--network=".length)
    : spaced !== -1
      ? args[spaced + 1]
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
