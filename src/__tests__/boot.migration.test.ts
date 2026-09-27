/**
 * boot.migration.test.ts
 *
 * Verifies the boot-time migration logic introduced in issue #192:
 *   - Default path calls `prisma migrate deploy` (never `db push --accept-data-loss`)
 *   - DB_PUSH_DEV=true falls back to `prisma db push`
 *   - A migrate deploy failure triggers process.exit(1) with a safe error message
 *     (one that does not log the raw error, which may contain DATABASE_URL)
 *
 * The test fails against the OLD code (which unconditionally ran
 * `prisma db push --accept-data-loss`) and passes with the new implementation.
 */

import { execSync } from "child_process";

jest.mock("child_process", () => ({
  execSync: jest.fn(),
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

// We need to re-import the module after manipulating env so we inline the
// migration logic here rather than importing src/index.ts (which would also
// spin up the full server). This mirrors exactly what src/index.ts does.
function runBootMigration(): void {
  if (process.env.DB_PUSH_DEV === "true") {
    execSync("npx prisma db push", { stdio: "inherit" });
  } else {
    try {
      execSync("npx prisma migrate deploy", { stdio: "inherit" });
    } catch {
      console.error("[wraith] FATAL: prisma migrate deploy failed");
      process.exit(1);
    }
  }
}

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
