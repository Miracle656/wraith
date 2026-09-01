import { prisma } from "../db";

export type PartitionMetadata = {
  name: string;
  schema: string;
  parentTable: string;
  rangeEnd: Date;
  sizeBytes: number;
};

export type RetentionPlan = {
  compress: PartitionMetadata[];
  archive: PartitionMetadata[];
  skipped: PartitionMetadata[];
};

function monthsBetween(start: Date, end: Date): number {
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
}

function inferPartitionRangeEnd(name: string): Date | null {
  const match = name.match(/_(\d{4})(\d{2})(\d{2})?$/);
  if (!match) return null;

  const [, year, month, day] = match;
  return new Date(Date.UTC(parseInt(year, 10), parseInt(month, 10) - 1, day ? parseInt(day, 10) : 1));
}

function formatQualifiedIdentifier(identifier: string): string {
  return identifier
    .split(".")
    .filter(Boolean)
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(".");
}

export function planPartitionRetention(
  partitions: PartitionMetadata[],
  now: Date,
  compressionWindowMonths = 3,
  retentionWindowMonths = 6
): RetentionPlan {
  const compress: PartitionMetadata[] = [];
  const archive: PartitionMetadata[] = [];
  const skipped: PartitionMetadata[] = [];

  for (const partition of partitions) {
    const ageMonths = monthsBetween(partition.rangeEnd, now);

    if (ageMonths >= retentionWindowMonths) {
      archive.push(partition);
    } else if (ageMonths >= compressionWindowMonths) {
      compress.push(partition);
    } else {
      skipped.push(partition);
    }
  }

  return { compress, archive, skipped };
}

export async function runPartitionRetentionJob(options?: {
  compressionWindowMonths?: number;
  retentionWindowMonths?: number;
}): Promise<{ compressed: number; archived: number; reclaimedBytes: number; skipped: number }> {
  const compressionWindowMonths = options?.compressionWindowMonths ?? 3;
  const retentionWindowMonths = options?.retentionWindowMonths ?? 6;

  const partitions = await prisma.$queryRaw<Array<{ name: string; schema: string; parentTable: string; sizeBytes: number }>>`
    SELECT
      c.oid::regclass::text AS name,
      n.nspname AS schema,
      p.relname AS parent_table,
      pg_total_relation_size(c.oid) AS size_bytes
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'wraith'
      AND p.relnamespace = n.oid
      AND c.relkind = 'r'
  `;

  const plan = planPartitionRetention(
    partitions.map((partition) => ({
      ...partition,
      rangeEnd: inferPartitionRangeEnd(partition.name) ?? new Date(0),
      sizeBytes: Number(partition.sizeBytes ?? 0),
    })),
    new Date(),
    compressionWindowMonths,
    retentionWindowMonths,
  );

  let reclaimedBytes = 0;
  let compressed = 0;
  let archived = 0;

  await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS "wraith_archive"');

  for (const partition of plan.compress) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE ${formatQualifiedIdentifier(partition.name)} SET (toast.compress = 'pglz')`
    );
    compressed += 1;
    reclaimedBytes += partition.sizeBytes;
  }

  for (const partition of plan.archive) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE ${formatQualifiedIdentifier(partition.name)} SET SCHEMA "wraith_archive"`
    );
    archived += 1;
    reclaimedBytes += partition.sizeBytes;
  }

  await prisma.$executeRawUnsafe(`
    INSERT INTO "wraith"."RetentionJobRun" ("compressed", "archived", "reclaimedBytes", "skipped", "status", "finishedAt")
    VALUES (${compressed}, ${archived}, ${reclaimedBytes}, ${plan.skipped.length}, 'completed', NOW())
  `);

  console.log(
    `[retention] compressed=${compressed} archived=${archived} reclaimedBytes=${reclaimedBytes} skipped=${plan.skipped.length}`
  );

  return { compressed, archived, reclaimedBytes, skipped: plan.skipped.length };
}

export function startPartitionRetentionJob(): NodeJS.Timeout | null {
  const intervalMs = parseInt(process.env.PARTITION_RETENTION_INTERVAL_MS ?? `${6 * 60 * 60 * 1000}`, 10);
  if (Number.isNaN(intervalMs) || intervalMs <= 0) {
    return null;
  }

  void runPartitionRetentionJob().catch((error) => {
    console.error("[retention] Job failed:", error);
  });

  return setInterval(() => {
    void runPartitionRetentionJob().catch((error) => {
      console.error("[retention] Job failed:", error);
    });
  }, intervalMs);
}
