import "dotenv/config";
import http from "http";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { randomUUID } from "crypto";
import { createApp } from "./api";
import { startAllIndexers } from "./indexer";
import { prisma } from "./db";
import { attachWebSocketServer } from "./ws";
import { attachGraphQLSubscriptions, SUBSCRIPTIONS_PATH } from "./graphql/subscriptions";
import { startWebhookWorker } from "./workers/webhooks";
import { startPartitionRetentionJob } from "./jobs/retention";
import { startOrderReconciliationJob } from "./jobs/orderReconciliation";
import { initTokenCache } from "./tokenCache";
import { enabledNetworks } from "./network";
import { onlyAddsUniqueConstraints, pushSchema } from "./schemaGuard";
import { auditMigrationHistory, missingSchemaObjects } from "./schemaState";
import { startOhlcRefreshWorker } from "./workers/ohlc-refresh";
import { getOhlcRefreshIntervalMs } from "./ohlcConfig";
import { validateEnv } from "./validateEnv";
import { logger } from "./logger";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Resolve the commit that is actually running, from the build rather than from
// a file someone edits by hand. Order of preference:
//   1. GIT_COMMIT_SHA — injected by the deploy workflow at build time.
//   2. The .git/HEAD of the checkout the process was started from (dev/local).
//   3. "unknown" — never a stale hand-maintained value.
function resolveRunningCommit(): string {
  const injected = process.env.GIT_COMMIT_SHA?.trim();
  if (injected) return injected;
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const RUNNING_COMMIT = resolveRunningCommit();
const BUILD_TIME = process.env.BUILD_TIME?.trim() ?? "unknown";

async function main() {
  // First thing in `main`, not at module load. A missing DATABASE_URL should
  // stop the process with the name of what is missing, rather than surface
  // later as a connection error that says nothing about configuration. It runs
  // here rather than top-level because the startup-wiring tests import this
  // module, and a module-load throw would fail them on an env they do not need.
  validateEnv();

  // Log the running commit before anything else so a stale deploy is visible
  // in the logs even if the process later crashes during startup.
  logger.info("server.commit", { route: "startup", status: 0, durationMs: 0, requestId: "boot", commit: RUNNING_COMMIT, buildTime: BUILD_TIME });

  const bootId = randomUUID();

  // ── What the database actually has ──────────────────────────────────────────
  // Record the migration-history finding first. Diagnostic only: this database
  // was built by `db push`, so an absent or partial `_prisma_migrations` is the
  // expected finding (docs/drift-recovery.md records the investigation), and
  // this never writes to it, never baselines and never resolves a migration.
  // Doing so automatically would mark an unrecorded migration as applied —
  // hiding the one that genuinely is not.
  try {
    const audit = await auditMigrationHistory(prisma);
    logger.info("schema.migrations.audit", {
      route: "startup",
      status: 0,
      durationMs: 0,
      requestId: bootId,
      historyTablePresent: audit.historyTablePresent,
      historySchema: audit.historySchema,
      applied: audit.appliedCount,
      failed: audit.failedCount,
      unrecorded: audit.unrecorded.length,
      unexpected: audit.unexpected.length,
    });
    if (!audit.historyTablePresent) {
      logger.warn("schema.migrations.history_absent", {
        route: "startup",
        status: 0,
        durationMs: 0,
        requestId: bootId,
        unrecorded: audit.unrecorded.length,
      });
    } else if (audit.unrecorded.length > 0) {
      logger.warn("schema.migrations.unrecorded", {
        route: "startup",
        status: 0,
        durationMs: 0,
        requestId: bootId,
        count: audit.unrecorded.length,
        migrations: audit.unrecorded,
      });
    }
    if (audit.unexpected.length > 0) {
      logger.error("schema.migrations.unexpected", {
        route: "startup",
        status: 0,
        durationMs: 0,
        requestId: bootId,
        count: audit.unexpected.length,
        migrations: audit.unexpected,
      });
    }
    if (audit.failedCount > 0) {
      logger.error("schema.migrations.failed_rows", {
        route: "startup",
        status: 0,
        durationMs: 0,
        requestId: bootId,
        count: audit.failedCount,
      });
    }
  } catch (err) {
    // A history that cannot be read is not an empty history. The drift check
    // below is the one that gates startup; this is the record that the audit
    // itself failed, so nobody mistakes silence for "no unrecorded migrations".
    logger.warn("schema.migrations.audit_failed", {
      route: "startup",
      status: 0,
      durationMs: 0,
      requestId: bootId,
      errorName: (err as Error)?.name ?? "unknown error",
    });
  }

  // Detect before converging, so a deploy that is about to bring a column into
  // existence says so in the log instead of changing the schema silently. If
  // the database cannot be inspected, refuse to start: serving on an unverified
  // schema is the state this check exists to rule out.
  let missing = await missingSchemaObjects(prisma).catch((err) => {
    logger.error("schema.drift.check_failed", {
      route: "startup",
      status: 0,
      durationMs: 0,
      requestId: bootId,
      errorName: (err as Error)?.name ?? "unknown error",
    });
    process.exit(1);
  });
  if (missing.length > 0) {
    logger.warn("schema.drift.detected", {
      route: "startup",
      status: 0,
      durationMs: 0,
      requestId: bootId,
      count: missing.length,
      tables: missing.map((object) => object.table),
      missingColumns: missing.map((object) => object.missingColumns),
    });
  }

  // Converge the schema on every startup, so a deploy needs no separate
  // pre-deploy step.
  //
  // This is `db push` rather than `migrate deploy` because the migration
  // history cannot support the latter: the committed migrations do not create
  // the `wraith` schema or most of the tables — TokenTransfer, OfframpOrder
  // and NgnOrder have no migration at all — because this database was built by
  // `db push` from the beginning. A fresh database aborts on the first
  // migration (`schema "wraith" does not exist`); this one aborts with P3005
  // ("database schema is not empty"). docs/drift-recovery.md records the
  // investigation and the evidence.
  //
  // The drift detected above is logged, applied if additive, and checked again
  // below. Detection is not a substitute for convergence: an insertion into a
  // column the database does not have is the outage this guards against, and on
  // the offramp it means a real provider order with no local record.
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
  logger.info("schema.converge.start", { route: "startup", status: 0, durationMs: 0, requestId: bootId });
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
      logger.warn("schema.converge.unique_constraints_only", { route: "startup", status: 0, durationMs: 0, requestId: bootId });
      const retry = pushSchema("--accept-data-loss");
      if (!retry.ok) {
        logger.error("schema.converge.constraint_failed", { route: "startup", status: 0, durationMs: 0, requestId: bootId });
        process.exit(1);
      }
    } else {
      logger.error("schema.converge.refused_destructive", { route: "startup", status: 0, durationMs: 0, requestId: bootId });
      process.exit(1);
    }
  }
  logger.info("schema.converge.ready", { route: "startup", status: 0, durationMs: 0, requestId: bootId });

  // Verify, rather than assume, that convergence worked. A database still
  // behind the code after the push is fatal: the alternative is serving routes
  // whose writes fail, which is exactly the state #277 describes.
  missing = await missingSchemaObjects(prisma).catch((err) => {
    logger.error("schema.drift.verify_failed", {
      route: "startup",
      status: 0,
      durationMs: 0,
      requestId: bootId,
      errorName: (err as Error)?.name ?? "unknown error",
    });
    process.exit(1);
  });
  if (missing.length > 0) {
    logger.error("schema.drift.unresolved", {
      route: "startup",
      status: 0,
      durationMs: 0,
      requestId: bootId,
      count: missing.length,
      tables: missing.map((object) => object.table),
      missingColumns: missing.map((object) => object.missingColumns),
    });
    process.exit(1);
  }
  logger.info("schema.verified", { route: "startup", status: 0, durationMs: 0, requestId: bootId });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  let stopOhlcRefreshWorker: (() => void) | undefined;
  const shutdown = async (signal: string) => {
    logger.info("shutdown.received", { route: "startup", status: 0, durationMs: 0, requestId: bootId, signal });
    stopOhlcRefreshWorker?.();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // ── Start REST API + WebSocket server ─────────────────────────────────────
  const app = createApp();
  app.set("runningCommit", RUNNING_COMMIT);
  const server = http.createServer(app);

  // Attach WebSocket upgrade handler — clients connect to /subscribe/:address
  attachWebSocketServer(server);

  // Attach GraphQL subscriptions — clients connect to /graphql/subscriptions
  attachGraphQLSubscriptions(server);

  server.listen(PORT, () => {
    logger.info("server.listen", { route: "startup", status: 0, durationMs: 0, requestId: bootId, port: PORT });
    logger.info("server.ws_ready", { route: "startup", status: 0, durationMs: 0, requestId: bootId, path: "/subscribe/:address" });
    logger.info("server.graphql_ready", { route: "startup", status: 0, durationMs: 0, requestId: bootId, path: SUBSCRIPTIONS_PATH });
  });

  // ── Start webhook worker ───────────────────────────────────────────────────
  startWebhookWorker();

  // ── Start partition retention scheduler ───────────────────────────────────
  startPartitionRetentionJob();

  // The webhook is the fast path; this catches orders whose event never arrived.
  startOrderReconciliationJob();

  // Seed token metadata for every served network before handling read paths.
  // API-only deployments skip the indexer, so without this explicit seed their
  // displayAmount values would silently fall back to 7 decimals for every token.
  await Promise.all(enabledNetworks().map((network) => initTokenCache(network)));

  // Opt in only after the OHLC tables and refresh functions are available.
  const ohlcIntervalMs = getOhlcRefreshIntervalMs();
  if (ohlcIntervalMs !== undefined) {
    stopOhlcRefreshWorker = startOhlcRefreshWorker(ohlcIntervalMs);
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
    logger.info("indexer.skipped", { route: "startup", status: 0, durationMs: 0, requestId: bootId });
  } else {
    // One loop per enabled network (NETWORKS env; defaults to STELLAR_NETWORK).
    // Each loop restarts itself on crash rather than taking the process down —
    // a mainnet RPC key expiring must not stop testnet indexing, nor the API.
    startAllIndexers();
  }
}

// Called unconditionally, not behind `require.main === module`:
// src/__tests__/ohlcStartup.test.ts boots the real entrypoint with
// `jest.isolateModules(() => require("../index"))` to assert the startup
// wiring, and under that require this module is not `require.main`.
main();
