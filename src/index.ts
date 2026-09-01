import "dotenv/config";
import http from "http";
import { execSync } from "child_process";
import { createApp } from "./api";
import { startAllIndexers } from "./indexer";
import { prisma } from "./db";
import { attachWebSocketServer } from "./ws";
import { attachGraphQLSubscriptions, SUBSCRIPTIONS_PATH } from "./graphql/subscriptions";
import { startWebhookWorker } from "./workers/webhooks";
import { startPartitionRetentionJob } from "./jobs/retention";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function main() {
  // Run DB migrations on every startup so Render deployments always have
  // an up-to-date schema without needing a separate pre-deploy step.
  console.log("[wraith] Running database migrations…");
  execSync("npx prisma db push --accept-data-loss", { stdio: "inherit" });
  console.log("[wraith] Database ready.");

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n[wraith] Received ${signal} — shutting down gracefully…`);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // ── Start REST API + WebSocket server ─────────────────────────────────────
  const app = createApp();
  const server = http.createServer(app);

  // Attach WebSocket upgrade handler — clients connect to /subscribe/:address
  attachWebSocketServer(server);

  // Attach GraphQL subscriptions — clients connect to /graphql/subscriptions
  attachGraphQLSubscriptions(server);

  server.listen(PORT, () => {
    console.log(`[wraith] API listening on http://localhost:${PORT}`);
    console.log(`[wraith] WebSocket subscriptions available at ws://localhost:${PORT}/subscribe/:address`);
    console.log(`[wraith] GraphQL subscriptions available at ws://localhost:${PORT}${SUBSCRIPTIONS_PATH}`);
  });

  // ── Start webhook worker ───────────────────────────────────────────────────
  startWebhookWorker();

  // ── Start partition retention scheduler ───────────────────────────────────
  startPartitionRetentionJob();

  // ── Start indexer in the background ───────────────────────────────────────
  // startIndexer() runs an infinite loop; we intentionally don't await it
  // so the API stays responsive while indexing happens concurrently.
  //
  // SKIP_INDEXER lets a deployment serve the read API without a live Soroban
  // RPC connection — used by the integration test stack (docker-compose.test.yml),
  // which exercises the HTTP surface only. Without this guard the indexer throws
  // on the missing RPC endpoint and takes the whole process (and API) down.
  if (process.env.SKIP_INDEXER === "true") {
    console.log("[wraith] SKIP_INDEXER=true — indexer not started (API-only mode)");
  } else {
    // One loop per enabled network (NETWORKS env; defaults to STELLAR_NETWORK).
    // Each loop restarts itself on crash rather than taking the process down —
    // a mainnet RPC key expiring must not stop testnet indexing, nor the API.
    startAllIndexers();
  }
}

main();
