import { PrismaClient } from "@prisma/client";
import { seedTransfers } from "./fixtures";

process.env.DATABASE_URL ??= "postgresql://wraith:wraith@localhost:55432/wraith_test";
process.env.DIRECT_DATABASE_URL ??= "postgresql://wraith:wraith@localhost:55432/wraith_test";

const API_BASE_URL = process.env.INTEGRATION_API_URL ?? "http://localhost:3300";

async function waitForApi(): Promise<void> {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      // Per-request timeout: without it a single hung connection (an unhealthy
      // container that accepts sockets but never responds) blocks forever and
      // the deadline check below is never reached.
      const response = await fetch(`${API_BASE_URL}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
    } catch {
      // The compose service may still be booting.
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for Wraith API at ${API_BASE_URL}`);
}

export async function seedIntegrationFixtures(): Promise<void> {
  await waitForApi();

  const prisma = new PrismaClient();
  try {
    await prisma.tokenTransfer.deleteMany();
    await prisma.indexerState.deleteMany();
    await prisma.tokenTransfer.createMany({ data: seedTransfers });
    await prisma.indexerState.create({ data: { network: 'testnet', lastIndexedLedger: 2006 } });
  } finally {
    await prisma.$disconnect();
  }
}

await seedIntegrationFixtures();
