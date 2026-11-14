import { Worker } from "worker_threads";

class PgWorkerClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: Error) => void }
  >();

  constructor() {
    const pglitePath = require.resolve("@electric-sql/pglite");
    const script = `
      const { parentPort } = require("worker_threads");
      const { PGlite } = require(${JSON.stringify(pglitePath)});
      let pg = null;
      parentPort.on("message", async (msg) => {
        const { id, type, sql } = msg;
        try {
          if (!pg) pg = new PGlite();
          if (type === "close") {
            await pg.close();
            parentPort.postMessage({ id, ok: true });
          } else if (type === "exec") {
            await pg.exec(sql);
            parentPort.postMessage({ id, ok: true });
          } else {
            const res = await pg.query(sql);
            parentPort.postMessage({ id, ok: true, rows: res.rows, affectedRows: res.affectedRows ?? 0 });
          }
        } catch (err) {
          parentPort.postMessage({
            id,
            ok: false,
            message: err && err.message ? err.message : String(err),
            code: err && err.code ? err.code : undefined,
          });
        }
      });
    `;
    this.worker = new Worker(script, { eval: true });
    this.worker.on("message", (msg: { id: number; ok: boolean; rows?: any[]; affectedRows?: number; message?: string; code?: string }) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg);
      } else {
        const err = Object.assign(new Error(msg.message ?? "PG error"), { code: msg.code });
        entry.reject(err);
      }
    });
  }

  private send(type: "exec" | "query" | "close", sql?: string): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, sql });
    });
  }

  async exec(sql: string): Promise<void> {
    await this.send("exec", sql);
  }

  async query<T = Record<string, any>>(sql: string): Promise<{ rows: T[]; affectedRows: number }> {
    const res = await this.send("query", sql);
    return { rows: res.rows as T[], affectedRows: res.affectedRows ?? 0 };
  }

  async close(): Promise<void> {
    await this.send("close");
    await this.worker.terminate();
  }
}

let activePg: PgWorkerClient | null = null;
let beforeExecuteHook: ((sql: string) => Promise<void> | void) | null = null;

jest.mock("../db", () => ({
  prisma: {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      if (!activePg) throw new Error("PgWorkerClient not initialized");
      const sql =
        typeof strings === "string"
          ? strings
          : strings.reduce(
              (acc, part, idx) => acc + part + (idx < values.length ? String(values[idx]) : ""),
              "",
            );
      const res = await activePg.query(sql);
      return res.rows;
    }),
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      if (!activePg) throw new Error("PgWorkerClient not initialized");
      if (beforeExecuteHook) {
        await beforeExecuteHook(sql);
      }
      const res = await activePg.query(sql);
      return res.affectedRows ?? 0;
    }),
  },
}));

import {
  formatQualifiedIdentifier,
  inferPartitionRangeEnd,
  planPartitionRetention,
  runPartitionRetentionJob,
  startPartitionRetentionJob,
  type PartitionMetadata,
} from "../jobs/retention";

async function bootstrapRetentionSchema(pg: PgWorkerClient): Promise<void> {
  await pg.exec(`
    DROP SCHEMA IF EXISTS "wraith_archive" CASCADE;
    DROP SCHEMA IF EXISTS "wraith" CASCADE;
    CREATE SCHEMA "wraith";

    CREATE TABLE "wraith"."RetentionJobRun" (
      "id" SERIAL PRIMARY KEY,
      "network" TEXT NOT NULL DEFAULT 'testnet',
      "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "finishedAt" TIMESTAMP(3) NOT NULL,
      "compressed" INTEGER NOT NULL DEFAULT 0,
      "archived" INTEGER NOT NULL DEFAULT 0,
      "reclaimedBytes" BIGINT NOT NULL DEFAULT 0,
      "skipped" INTEGER NOT NULL DEFAULT 0,
      "status" TEXT NOT NULL DEFAULT 'completed'
    );

    CREATE TABLE "wraith"."token_transfers" (
      "id" SERIAL PRIMARY KEY,
      "txHash" TEXT NOT NULL,
      "amount" TEXT NOT NULL
    );

    CREATE TABLE "wraith"."AccountSummary" (
      "id" SERIAL PRIMARY KEY,
      "address" TEXT NOT NULL
    );
    INSERT INTO "wraith"."AccountSummary" ("address") VALUES ('GABC123');
  `);
}

async function createChildPartition(
  pg: PgWorkerClient,
  schema: string,
  parent: string,
  name: string,
  rowCount = 2,
): Promise<void> {
  await pg.exec(`
    CREATE TABLE "${schema}"."${name}" () INHERITS ("${schema}"."${parent}");
  `);
  for (let i = 0; i < rowCount; i++) {
    await pg.exec(`
      INSERT INTO "${schema}"."${name}" ("txHash", "amount")
      VALUES ('tx_${name}_${i}', '${(i + 1) * 100}');
    `);
  }
}

async function getTablePlacements(
  pg: PgWorkerClient,
): Promise<Array<{ schema: string; name: string; reloptions: string[] | null }>> {
  const res = await pg.query<{
    schema: string;
    name: string;
    reloptions: string[] | null;
  }>(`
    SELECT
      n.nspname AS schema,
      c.relname AS name,
      c.reloptions AS reloptions
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('wraith', 'wraith_archive')
      AND c.relkind = 'r'
    ORDER BY n.nspname ASC, c.relname ASC
  `);
  return res.rows;
}

describe("formatQualifiedIdentifier and inferPartitionRangeEnd", () => {
  it("quotes single and schema-qualified identifiers", () => {
    expect(formatQualifiedIdentifier("token_transfers_202406")).toBe('"token_transfers_202406"');
    expect(formatQualifiedIdentifier("wraith.token_transfers_202406")).toBe(
      '"wraith"."token_transfers_202406"',
    );
  });

  it("doubles embedded double-quotes and strips empty dot segments", () => {
    expect(formatQualifiedIdentifier('wraith.part"ition_202406')).toBe(
      '"wraith"."part""ition_202406"',
    );
    expect(
      formatQualifiedIdentifier('wraith.token_transfers_202406"; DROP TABLE "TokenTransfer'),
    ).toBe('"wraith"."token_transfers_202406""; DROP TABLE ""TokenTransfer"');
    expect(formatQualifiedIdentifier("wraith..token_transfers_202406.")).toBe(
      '"wraith"."token_transfers_202406"',
    );
  });

  it("parses monthly and daily partition suffixes and returns null for non-matching names", () => {
    expect(inferPartitionRangeEnd("token_transfers_202406")?.toISOString()).toBe(
      "2024-06-01T00:00:00.000Z",
    );
    expect(inferPartitionRangeEnd("token_transfers_20240615")?.toISOString()).toBe(
      "2024-06-15T00:00:00.000Z",
    );
    expect(inferPartitionRangeEnd("token_transfers_latest")).toBeNull();
  });
});

describe("planPartitionRetention", () => {
  it("compresses older partitions and archives partitions beyond the retention window", () => {
    const now = new Date("2024-12-15T00:00:00.000Z");
    const partitions: PartitionMetadata[] = [
      {
        name: "token_transfers_202406",
        schema: "wraith",
        parentTable: "token_transfers",
        rangeEnd: new Date("2024-06-01T00:00:00.000Z"),
        sizeBytes: 1_024,
      },
      {
        name: "token_transfers_202409",
        schema: "wraith",
        parentTable: "token_transfers",
        rangeEnd: new Date("2024-09-01T00:00:00.000Z"),
        sizeBytes: 2_048,
      },
      {
        name: "token_transfers_202411",
        schema: "wraith",
        parentTable: "token_transfers",
        rangeEnd: new Date("2024-11-01T00:00:00.000Z"),
        sizeBytes: 4_096,
      },
    ];

    const plan = planPartitionRetention(partitions, now, 3, 6);

    expect(plan.compress.map((partition) => partition.name)).toEqual(["token_transfers_202409"]);
    expect(plan.archive.map((partition) => partition.name)).toEqual(["token_transfers_202406"]);
    expect(plan.skipped.map((partition) => partition.name)).toEqual(["token_transfers_202411"]);
  });
});

describe("runPartitionRetentionJob against real PostgreSQL engine", () => {
  const NOW = new Date("2024-12-15T00:00:00.000Z");

  beforeAll(async () => {
    activePg = new PgWorkerClient();
    await bootstrapRetentionSchema(activePg);
  });

  afterAll(async () => {
    if (activePg) {
      await activePg.close();
      activePg = null;
    }
  });

  beforeEach(async () => {
    beforeExecuteHook = null;
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    await bootstrapRetentionSchema(activePg!);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("archives partitions past retention, compresses mid-aged partitions, and leaves unplanned partitions and tables untouched", async () => {
    const pg = activePg!;
    // Archive candidates (>= 6 months before 2024-12)
    await createChildPartition(pg, "wraith", "token_transfers", "token_transfers_202401", 3);
    await createChildPartition(pg, "wraith", "token_transfers", "token_transfers_202406", 2);
    // Compress candidate (3..5 months before 2024-12)
    await createChildPartition(pg, "wraith", "token_transfers", "token_transfers_202409", 2);
    // Active / skipped partitions (< 3 months before 2024-12)
    await createChildPartition(pg, "wraith", "token_transfers", "token_transfers_202411", 4);
    await createChildPartition(pg, "wraith", "token_transfers", "token_transfers_202412", 5);

    // Unrelated partition in public schema that must never be touched
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS "public"."other_parent" ("id" SERIAL PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS "public"."other_part_202001" () INHERITS ("public"."other_parent");
    `);

    const result = await runPartitionRetentionJob({
      now: NOW,
      compressionWindowMonths: 3,
      retentionWindowMonths: 6,
    });

    expect(result.archived).toBe(2);
    expect(result.compressed).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.reclaimedBytes).toBeGreaterThan(0);

    const placements = await getTablePlacements(pg);
    const inArchive = placements.filter((p) => p.schema === "wraith_archive").map((p) => p.name);
    const inWraith = placements.filter((p) => p.schema === "wraith").map((p) => p.name);

    // Planned archive partitions moved to wraith_archive
    expect(inArchive).toEqual(["token_transfers_202401", "token_transfers_202406"]);

    // Planned compress + skipped partitions + non-partition tables remain in wraith
    expect(inWraith).toEqual([
      "AccountSummary",
      "RetentionJobRun",
      "token_transfers",
      "token_transfers_202409",
      "token_transfers_202411",
      "token_transfers_202412",
    ]);

    // Compressed partition has toast_tuple_target=128 reloption set; skipped partitions have no reloptions
    const compressedMeta = placements.find((p) => p.name === "token_transfers_202409");
    expect(compressedMeta?.reloptions).toEqual(["toast_tuple_target=128"]);

    const skipped11 = placements.find((p) => p.name === "token_transfers_202411");
    const skipped12 = placements.find((p) => p.name === "token_transfers_202412");
    expect(skipped11?.reloptions).toBeNull();
    expect(skipped12?.reloptions).toBeNull();

    // Data inside archived and untouched partitions is preserved
    const archivedRows = await pg.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "wraith_archive"."token_transfers_202401"`,
    );
    expect(archivedRows.rows[0].count).toBe("3");

    const untouchedRows = await pg.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "wraith"."token_transfers_202411"`,
    );
    expect(untouchedRows.rows[0].count).toBe("4");

    const summaryRows = await pg.query<{ address: string }>(
      `SELECT "address" FROM "wraith"."AccountSummary"`,
    );
    expect(summaryRows.rows).toEqual([{ address: "GABC123" }]);

    // Public schema partition is still in public
    const publicPart = await pg.query<{ schema: string }>(`
      SELECT n.nspname AS schema
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'other_part_202001'
    `);
    expect(publicPart.rows).toEqual([{ schema: "public" }]);

    // RetentionJobRun audit row was recorded
    const runs = await pg.query<{
      compressed: number;
      archived: number;
      skipped: number;
      status: string;
    }>(`SELECT "compressed", "archived", "skipped", "status" FROM "wraith"."RetentionJobRun"`);
    expect(runs.rows).toEqual([
      { compressed: 1, archived: 2, skipped: 2, status: "completed" },
    ]);
  });

  it("succeeds idempotently when wraith_archive already exists and partitions were already archived", async () => {
    const pg = activePg!;
    await pg.exec(`CREATE SCHEMA "wraith_archive"`);
    await createChildPartition(pg, "wraith", "token_transfers", "token_transfers_202405", 2);
    await createChildPartition(pg, "wraith", "token_transfers", "token_transfers_202411", 2);

    const first = await runPartitionRetentionJob({ now: NOW });
    expect(first).toMatchObject({ archived: 1, compressed: 0, skipped: 1 });

    // Second run: wraith_archive already exists and token_transfers_202405 is already in wraith_archive
    const second = await runPartitionRetentionJob({ now: NOW });
    expect(second).toMatchObject({ archived: 0, compressed: 0, skipped: 1 });

    const placements = await getTablePlacements(pg);
    expect(placements.filter((p) => p.schema === "wraith_archive").map((p) => p.name)).toEqual([
      "token_transfers_202405",
    ]);
  });

  it("handles a partition disappearing between planning and execution without aborting remaining partitions", async () => {
    const pg = activePg!;
    await createChildPartition(pg, "wraith", "token_transfers", "token_transfers_202401", 2);
    await createChildPartition(pg, "wraith", "token_transfers", "token_transfers_202405", 2);
    await createChildPartition(pg, "wraith", "token_transfers", "token_transfers_202409", 2);
    await createChildPartition(pg, "wraith", "token_transfers", "token_transfers_202411", 2);

    // Drop token_transfers_202401 and token_transfers_202409 right as CREATE SCHEMA runs
    // (after planning has already read pg_inherits, before ALTER TABLE executes).
    beforeExecuteHook = async (sql: string) => {
      if (sql.includes("CREATE SCHEMA IF NOT EXISTS")) {
        await pg.exec(`
          DROP TABLE "wraith"."token_transfers_202401";
          DROP TABLE "wraith"."token_transfers_202409";
        `);
      }
    };

    const result = await runPartitionRetentionJob({ now: NOW });

    // Only the surviving archive partition (202405) is counted as archived;
    // the vanished compress partition (202409) is not counted.
    expect(result.archived).toBe(1);
    expect(result.compressed).toBe(0);
    expect(result.skipped).toBe(1);

    const placements = await getTablePlacements(pg);
    expect(placements.filter((p) => p.schema === "wraith_archive").map((p) => p.name)).toEqual([
      "token_transfers_202405",
    ]);
    expect(placements.filter((p) => p.schema === "wraith").map((p) => p.name)).toContain(
      "token_transfers_202411",
    );
  });

  it("recovers cleanly when interrupted halfway through archiving and then re-run", async () => {
    const pg = activePg!;
    await createChildPartition(pg, "wraith", "token_transfers", "token_transfers_202401", 2);
    await createChildPartition(pg, "wraith", "token_transfers", "token_transfers_202405", 2);
    await createChildPartition(pg, "wraith", "token_transfers", "token_transfers_202411", 2);

    // Simulate interruption when archiving the second partition (token_transfers_202405)
    beforeExecuteHook = async (sql: string) => {
      if (sql.includes('"token_transfers_202405"') && sql.includes("SET SCHEMA")) {
        throw new Error("connection terminated unexpectedly");
      }
    };

    await expect(runPartitionRetentionJob({ now: NOW })).rejects.toThrow(
      "connection terminated unexpectedly",
    );

    // Halfway state: 202401 is in wraith_archive, 202405 is still in wraith, and no completed run row exists
    const midPlacements = await getTablePlacements(pg);
    expect(midPlacements.filter((p) => p.schema === "wraith_archive").map((p) => p.name)).toEqual([
      "token_transfers_202401",
    ]);
    expect(midPlacements.filter((p) => p.schema === "wraith").map((p) => p.name)).toContain(
      "token_transfers_202405",
    );
    const midRuns = await pg.query(`SELECT * FROM "wraith"."RetentionJobRun"`);
    expect(midRuns.rows).toHaveLength(0);

    // Clear the fault and re-run: completes archiving 202405 without failing on already-archived 202401
    beforeExecuteHook = null;
    const recovered = await runPartitionRetentionJob({ now: NOW });
    expect(recovered).toMatchObject({ archived: 1, compressed: 0, skipped: 1 });

    const finalPlacements = await getTablePlacements(pg);
    expect(finalPlacements.filter((p) => p.schema === "wraith_archive").map((p) => p.name)).toEqual([
      "token_transfers_202401",
      "token_transfers_202405",
    ]);
    const finalRuns = await pg.query<{ archived: number; status: string }>(
      `SELECT "archived", "status" FROM "wraith"."RetentionJobRun"`,
    );
    expect(finalRuns.rows).toEqual([{ archived: 1, status: "completed" }]);
  });
});

describe("startPartitionRetentionJob", () => {
  const savedEnv = process.env.PARTITION_RETENTION_INTERVAL_MS;

  beforeAll(async () => {
    if (!activePg) activePg = new PgWorkerClient();
  });

  afterAll(async () => {
    if (activePg) {
      await activePg.close();
      activePg = null;
    }
    if (savedEnv === undefined) delete process.env.PARTITION_RETENTION_INTERVAL_MS;
    else process.env.PARTITION_RETENTION_INTERVAL_MS = savedEnv;
  });

  it("returns null when PARTITION_RETENTION_INTERVAL_MS is 0, negative, or non-numeric", () => {
    for (const val of ["0", "-500", "invalid"]) {
      process.env.PARTITION_RETENTION_INTERVAL_MS = val;
      expect(startPartitionRetentionJob()).toBeNull();
    }
  });

  it("starts an interval timer when configured with a positive interval", async () => {
    await bootstrapRetentionSchema(activePg!);
    jest.spyOn(console, "log").mockImplementation(() => {});
    process.env.PARTITION_RETENTION_INTERVAL_MS = "60000";

    const timer = startPartitionRetentionJob();
    expect(timer).not.toBeNull();
    if (timer) clearInterval(timer);

    // Wait deterministically for the initial fire-and-forget job execution to record its run
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const runs = await activePg!.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "wraith"."RetentionJobRun"`,
      );
      if (Number(runs.rows[0]?.count ?? 0) >= 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    jest.restoreAllMocks();
  });
});
