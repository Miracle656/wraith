import "dotenv/config";
import { createApp } from "./api";
import { startIndexer } from "./indexer";
import { prisma } from "./db";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function main() {
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
