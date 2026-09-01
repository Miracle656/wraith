import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several integration suites (e2e, migrations, reorg, ws) use bare
    // describe/it without importing them, so globals must be enabled.
    globals: true,
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    // Run suites one file at a time: setup.ts reseeds a single shared Postgres
    // (deleteMany + createMany) per file, so parallel files race and collide on
    // the tokenTransfer.eventId unique constraint, corrupting each other's data.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
