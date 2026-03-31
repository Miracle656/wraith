import "dotenv/config";
import { execSync } from "child_process";
import { createApp } from "./api";
import { startIndexer } from "./indexer";
import { prisma } from "./db";

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

  // ── Start REST API ─────────────────────────────────────────────────────────
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`[wraith] API listening on http://localhost:${PORT}`);
  });

  // ── Start indexer in the background ───────────────────────────────────────
  // startIndexer() runs an infinite loop; we intentionally don't await it
  // so the API stays responsive while indexing happens concurrently.
  startIndexer().catch((err) => {
    console.error("[wraith] Indexer crashed — exiting:", err);
    process.exit(1);
  });
}

main();
