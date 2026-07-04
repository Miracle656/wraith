import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several integration suites (e2e, migrations, reorg, ws) use bare
    // describe/it without importing them, so globals must be enabled.
    globals: true,
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    testTimeout: 30_000,
  },
});
