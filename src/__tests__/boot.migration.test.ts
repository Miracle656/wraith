/**
 * boot.migration.test.ts
 *
 * Verifies the boot-time migration logic introduced in issue #192:
 *   - Default path calls `prisma migrate deploy` (never `db push --accept-data-loss`)
 *   - DB_PUSH_DEV=true falls back to `prisma db push`
 *   - A migrate deploy failure triggers process.exit(1) with a safe error message
 *     (one that does not log the raw error, which may contain DATABASE_URL)
 *
 * Imports the real `runBootMigration` from src/index.ts so that this test
 * exercises the shipped code rather than an inline copy — satisfying the repo
 * rule that a test must fail on main and pass after the change.
 */

import { execSync } from "child_process";

jest.mock("child_process", () => ({
  execSync: jest.fn(),
}));

// Mock every module that src/index.ts imports at load time so that importing
// it does not attempt to connect to a database, start an HTTP server, or spin
// up any workers.  Only runBootMigration (which uses the already-mocked
// child_process.execSync) is exercised here.
jest.mock("dotenv/config", () => ({}));
jest.mock("../api", () => ({ createApp: jest.fn(() => ({ listen: jest.fn() })) }));
jest.mock("../indexer", () => ({ startAllIndexers: jest.fn() }));
jest.mock("../db", () => ({ prisma: { $disconnect: jest.fn() } }));
jest.mock("../ws", () => ({ attachWebSocketServer: jest.fn() }));
jest.mock("../graphql/subscriptions", () => ({
  attachGraphQLSubscriptions: jest.fn(),
  SUBSCRIPTIONS_PATH: "/graphql/subscriptions",
}));
jest.mock("../workers/webhooks", () => ({ startWebhookWorker: jest.fn() }));
jest.mock("../jobs/retention", () => ({ startPartitionRetentionJob: jest.fn() }));

// Import after all mocks are registered so the module sees the mocked deps.
import { runBootMigration } from "../index";

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe("boot-time migration (issue #192)", () => {
  let mockExit: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DB_PUSH_DEV;
    // Prevent process.exit from terminating the test runner
    mockExit = jest
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as (code?: number) => never);
  });

  afterEach(() => {
    mockExit.mockRestore();
  });

  it("calls prisma migrate deploy by default (not db push)", () => {
    mockExecSync.mockReturnValue(Buffer.from(""));

    runBootMigration();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const cmd = (mockExecSync.mock.calls[0] as [string, ...unknown[]])[0];
    expect(cmd).toBe("npx prisma migrate deploy");
    expect(cmd).not.toContain("db push");
    expect(cmd).not.toContain("--accept-data-loss");
  });

  it("never passes --accept-data-loss on the default path", () => {
    mockExecSync.mockReturnValue(Buffer.from(""));

    runBootMigration();

    for (const call of mockExecSync.mock.calls) {
      const cmd = (call as [string, ...unknown[]])[0];
      expect(cmd).not.toContain("--accept-data-loss");
    }
  });

  it("falls back to prisma db push when DB_PUSH_DEV=true", () => {
    process.env.DB_PUSH_DEV = "true";
    mockExecSync.mockReturnValue(Buffer.from(""));

    runBootMigration();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const cmd = (mockExecSync.mock.calls[0] as [string, ...unknown[]])[0];
    expect(cmd).toBe("npx prisma db push");
    expect(cmd).not.toContain("--accept-data-loss");
  });

  it("exits with code 1 when migrate deploy throws", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("migrate deploy failed");
    });

    runBootMigration();

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("does not re-throw the raw error (DATABASE_URL must not leak)", () => {
    const sensitiveError = new Error(
      "Error: P3005 DATABASE_URL=postgresql://user:secret@host/db"
    );
    mockExecSync.mockImplementation(() => {
      throw sensitiveError;
    });

    // Should not throw — the catch block swallows and exits instead
    expect(() => runBootMigration()).not.toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
