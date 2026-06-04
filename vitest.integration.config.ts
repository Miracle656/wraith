import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["tests/integration/api.test.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    testTimeout: 30_000,
  },
});
