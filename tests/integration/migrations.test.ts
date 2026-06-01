import { execSync } from "child_process";

const DIRECT_DB = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;

function runPrisma(cmd: string) {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  if (DIRECT_DB) {
    env.DIRECT_DATABASE_URL = DIRECT_DB;
    env.DATABASE_URL = DIRECT_DB;
  }
  return execSync(`npx prisma ${cmd}`, { env, encoding: "utf8" }).toString();
}

describe("Migrations idempotency", () => {
  if (!DIRECT_DB) {
    test.skip("DIRECT_DATABASE_URL not set - skipping migration idempotency test", () => {});
    return;
  }

  test(
    "apply -> reset -> apply yields stable migration checksums",
    () => {
      jest.setTimeout(5 * 60 * 1000);

      // Apply all migrations (up)
      runPrisma("migrate deploy");

      // Capture migration checksums from the migrations table
      const first = runPrisma(
        `db execute --command "SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name;" --url \"${DIRECT_DB}\"`
      ).trim();

      // Reset will drop the DB and reapply migrations (down then up)
      runPrisma("migrate reset --force --skip-seed");

      // Re-capture checksums after running reset
      const second = runPrisma(
        `db execute --command "SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name;" --url \"${DIRECT_DB}\"`
      ).trim();

      expect(first).toBe(second);
    },
  );
});
