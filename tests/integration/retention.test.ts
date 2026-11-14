import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatQualifiedIdentifier,
  runPartitionRetentionJob,
} from "../../src/jobs/retention";
import { prisma } from "../../src/db";

describe("Partition retention job integration (Postgres)", () => {
  const TEST_PARENT = "retention_test_parent";
  const ARCHIVE_PART_1 = "retention_test_202001";
  const ARCHIVE_PART_2 = "retention_test_202002";
  const COMPRESS_PART = "retention_test_202409";
  const ACTIVE_PART = "retention_test_209912";
  const UNPLANNED_PUBLIC = "retention_public_202001";
  const NOW = new Date("2024-12-15T00:00:00.000Z");

  async function cleanupTestPartitions(): Promise<void> {
    for (const schema of ["wraith", "wraith_archive"]) {
      for (const rel of [ARCHIVE_PART_1, ARCHIVE_PART_2, COMPRESS_PART, ACTIVE_PART, TEST_PARENT]) {
        await prisma
          .$executeRawUnsafe(
            `DROP TABLE IF EXISTS ${formatQualifiedIdentifier(`${schema}.${rel}`)} CASCADE`,
          )
          .catch(() => {});
      }
    }
    await prisma
      .$executeRawUnsafe(
        `DROP TABLE IF EXISTS ${formatQualifiedIdentifier(`public.${UNPLANNED_PUBLIC}`)} CASCADE`,
      )
      .catch(() => {});
  }

  beforeEach(async () => {
    await cleanupTestPartitions();
    await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS "wraith"');
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "wraith"."RetentionJobRun" (
        "id" SERIAL PRIMARY KEY,
        "network" TEXT NOT NULL DEFAULT 'testnet',
        "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "finishedAt" TIMESTAMP(3) NOT NULL,
        "compressed" INTEGER NOT NULL DEFAULT 0,
        "archived" INTEGER NOT NULL DEFAULT 0,
        "reclaimedBytes" BIGINT NOT NULL DEFAULT 0,
        "skipped" INTEGER NOT NULL DEFAULT 0,
        "status" TEXT NOT NULL DEFAULT 'completed'
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "wraith"."${TEST_PARENT}" ("id" SERIAL PRIMARY KEY, "payload" TEXT)`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "wraith"."${ARCHIVE_PART_1}" () INHERITS ("wraith"."${TEST_PARENT}")`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "wraith"."${ARCHIVE_PART_2}" () INHERITS ("wraith"."${TEST_PARENT}")`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "wraith"."${COMPRESS_PART}" () INHERITS ("wraith"."${TEST_PARENT}")`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "wraith"."${ACTIVE_PART}" () INHERITS ("wraith"."${TEST_PARENT}")`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "public"."${UNPLANNED_PUBLIC}" ("id" SERIAL PRIMARY KEY, "payload" TEXT)`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "wraith"."${ARCHIVE_PART_1}" ("payload") VALUES ('archived-row-1')`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "wraith"."${ACTIVE_PART}" ("payload") VALUES ('active-row-1')`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanupTestPartitions();
    await prisma.$disconnect();
  });

  it("moves expired partitions to wraith_archive, sets compression on mid-aged partitions, and leaves unplanned tables untouched", async () => {
    const result = await runPartitionRetentionJob({
      now: NOW,
      compressionWindowMonths: 3,
      retentionWindowMonths: 6,
    });

    expect(result.archived).toBeGreaterThanOrEqual(2);
    expect(result.compressed).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    const rows = await prisma.$queryRaw<Array<{ schema: string; name: string }>>`
      SELECT n.nspname AS schema, c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname IN (${ARCHIVE_PART_1}, ${ARCHIVE_PART_2}, ${COMPRESS_PART}, ${ACTIVE_PART}, ${UNPLANNED_PUBLIC})
      ORDER BY c.relname ASC
    `;

    expect(rows).toEqual([
      { schema: "public", name: UNPLANNED_PUBLIC },
      { schema: "wraith_archive", name: ARCHIVE_PART_1 },
      { schema: "wraith_archive", name: ARCHIVE_PART_2 },
      { schema: "wraith", name: COMPRESS_PART },
      { schema: "wraith", name: ACTIVE_PART },
    ]);

    // Second run is idempotent when wraith_archive already exists and partitions were already moved
    const second = await runPartitionRetentionJob({
      now: NOW,
      compressionWindowMonths: 3,
      retentionWindowMonths: 6,
    });
    expect(second.archived).toBe(0);
  });

  it("skips a partition dropped between planning and DDL execution and recovers from halfway interruption", async () => {
    const realExec = prisma.$executeRawUnsafe.bind(prisma);
    let droppedOnce = false;
    let faultedOnce = false;

    vi.spyOn(prisma, "$executeRawUnsafe").mockImplementation((async (query: string, ...values: unknown[]) => {
      if (!droppedOnce && query.includes("CREATE SCHEMA IF NOT EXISTS")) {
        droppedOnce = true;
        await realExec(`DROP TABLE "wraith"."${ARCHIVE_PART_1}"`);
      }
      if (!faultedOnce && query.includes(`"${ARCHIVE_PART_2}"`) && query.includes("SET SCHEMA")) {
        faultedOnce = true;
        throw new Error("simulated mid-archive interruption");
      }
      return realExec(query, ...values);
    }) as typeof prisma.$executeRawUnsafe);

    await expect(
      runPartitionRetentionJob({ now: NOW, compressionWindowMonths: 3, retentionWindowMonths: 6 }),
    ).rejects.toThrow("simulated mid-archive interruption");

    vi.restoreAllMocks();

    const recovered = await runPartitionRetentionJob({
      now: NOW,
      compressionWindowMonths: 3,
      retentionWindowMonths: 6,
    });
    expect(recovered.archived).toBe(1);

    const rows = await prisma.$queryRaw<Array<{ schema: string; name: string }>>`
      SELECT n.nspname AS schema, c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname IN (${ARCHIVE_PART_1}, ${ARCHIVE_PART_2}, ${ACTIVE_PART})
      ORDER BY c.relname ASC
    `;
    expect(rows).toEqual([
      { schema: "wraith_archive", name: ARCHIVE_PART_2 },
      { schema: "wraith", name: ACTIVE_PART },
    ]);
  });

  it("escapes embedded double-quotes in formatQualifiedIdentifier", () => {
    expect(formatQualifiedIdentifier('wraith.part"ition_202406')).toBe(
      '"wraith"."part""ition_202406"',
    );
  });
});
