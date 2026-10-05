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
import { initTokenCache } from "./tokenCache";
import { enabledNetworks } from "./network";
import { onlyAddsUniqueConstraints, pushSchema } from "./schemaGuard";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function main() {
  // Converge the schema on every startup, so a deploy needs no separate
  // pre-deploy step.
  //
  // This is `db push` rather than `migrate deploy` because the migration
  // history cannot support the latter: `prisma/migrations` holds 7 migrations
  // covering 5 tables, while the schema defines 15. TokenTransfer,
  // AccountSummary, IndexerState and OfframpOrder have no migration at all —
  // this database was built by `db push` from the beginning. Switching without
  // baselining production first would create five tables and leave the app
  // crashing on the other ten.
  //
  // `--accept-data-loss` was removed deliberately. With it, any change Prisma
  // reads as destructive — a renamed column, a narrowed type, a dropped field
  // — applied silently on the next deploy, taking the column and everything in
  // it. This database holds offramp orders: records of real naira paid to real
  // bank accounts. A deploy that refuses to start is a problem someone fixes in
  // minutes; a column of payment records that vanished during a routine deploy
  // is not recoverable.
  //
  // Additive changes — a new table, a new nullable column — still apply on
  // their own. Anything destructive now fails loudly here instead.
  console.log("[wraith] Converging database schema…");
  const first = pushSchema();
  if (!first.ok) {
    // `--accept-data-loss` consents to two very different things at once, and
    // Prisma gives no way to agree to one without the other.
    //
    // Adding a unique constraint is NOT data loss: the index either builds or
    // fails on a duplicate, and nothing is dropped either way. Refusing it put
    // the service in a crash loop over a change that cannot destroy a row —
    // which is exactly how this guard took wraith down once.
    //
    // Dropping a column IS data loss, and that is what the guard is for.
    //
    // So the warnings get read rather than counted: if every one is an added
    // unique constraint, consent and retry. If even one is anything else,
    // refuse exactly as before.
    if (onlyAddsUniqueConstraints(first.output)) {
      console.warn(
        "[wraith] Schema diff is unique constraints only — no column is dropped.\n" +
          "[wraith] Applying. A duplicate would fail the index, not delete a row.",
      );
      const retry = pushSchema("--accept-data-loss");
      if (!retry.ok) {
        console.error(
          "[wraith] The constraint could not be applied — most likely duplicate\n" +
            "[wraith] rows already exist for it. Nothing was dropped. Resolve the\n" +
            "[wraith] duplicates and redeploy.",
        );
        process.exit(1);
      }
    } else {
      console.error(
        "[wraith] Schema convergence refused: the pending change is destructive.\n" +
          "[wraith] Nothing was dropped. Read the diff above — a rename or a type\n" +
          "[wraith] change needs a deliberate migration, not --accept-data-loss.",
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

  // Seed token metadata for every served network before handling read paths.
  // API-only deployments skip the indexer, so without this explicit seed their
  // displayAmount values would silently fall back to 7 decimals for every token.
  await Promise.all(enabledNetworks().map((network) => initTokenCache(network)));

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
