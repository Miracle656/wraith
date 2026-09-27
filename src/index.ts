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
  // ── Database schema migration ──────────────────────────────────────────────
  // Production path: apply every committed migration file in prisma/migrations/
  // via `prisma migrate deploy`.  This is idempotent, safe, and never drops data.
  //
  // Dev/test escape hatch: set DB_PUSH_DEV=true to fall back to `prisma db push`
  // for rapid local iteration against a throwaway database.  This flag MUST NOT
  // be present in any production or staging environment.
  if (process.env.DB_PUSH_DEV === "true") {
    console.log("[wraith] DB_PUSH_DEV=true — running prisma db push (dev/test only)…");
    execSync("npx prisma db push", { stdio: "inherit" });
  } else {
    console.log("[wraith] Running prisma migrate deploy…");
    try {
      execSync("npx prisma migrate deploy", { stdio: "inherit" });
    } catch {
      // Do NOT log the raw error — it may contain the DATABASE_URL.
      console.error(
        "[wraith] FATAL: prisma migrate deploy failed — the database schema is out of sync.\n" +
          "  Run `npx prisma migrate status` to inspect pending migrations.\n" +
          "  See docs/drift-recovery.md for recovery steps if the database was previously\n" +
          "  managed by `db push`."
      );
      process.exit(1);
    }
  }
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

  // API-only mode. The integration harness starts the service to exercise HTTP
  // routes against a seeded database; letting the indexer loop run there would
  // make every request race an ingest that is also writing to the same tables,
  // and would need live RPC the harness has no reason to depend on.
  if (process.env.SKIP_INDEXER === "true") {
    console.log("[wraith] SKIP_INDEXER=true — API-only mode, indexer not started.");
    return;
  }

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
