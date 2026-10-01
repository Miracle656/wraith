import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    // Older files in this directory belong to standalone Jest/DB suites. This
    // command is the compose-backed black-box API suite for issue #63.
    include: ["tests/integration/api.test.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
