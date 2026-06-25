/**
 * Batch-insert throughput benchmark (issue #107)
 *
 * Measures rows-per-second for upsertTransfers across different batch sizes.
 * Run:  npm run bench
 * Output: bench/results.json
 */
import { Bench } from "tinybench";
import { writeFileSync } from "fs";
import { prisma } from "../src/db";
import type { TransferRecord } from "../src/db";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRecord(i: number, batchId: string): TransferRecord {
  return {
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    eventType: "transfer",
    fromAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    toAddress:   "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWWHF",
    amount:      "10000000",
    ledger:      1000 + i,
    ledgerClosedAt: new Date("2025-01-01T00:00:00Z"),
    txHash:      `bench-tx-${batchId}-${i}`,
    eventId:     `bench-${batchId}-${i}`,
  };
}

function makeBatch(size: number, batchId: string): TransferRecord[] {
  return Array.from({ length: size }, (_, i) => makeRecord(i, batchId));
}

// ── run ───────────────────────────────────────────────────────────────────────

async function main() {
  const BATCH_SIZES = [10, 100, 500, 1000, 5000];
  const ITERATIONS  = 5; // enough for stable numbers, keeps total time <1 min

  const bench = new Bench({ iterations: ITERATIONS });
  let callId = 0;

  for (const size of BATCH_SIZES) {
    bench.add(`upsertTransfers batch=${size}`, async () => {
      const id = `${size}-${callId++}`;
      await prisma.tokenTransfer.createMany({
        data: makeBatch(size, id),
        skipDuplicates: true,
      });
    });
  }

  console.log("Running batch-insert benchmark…");
  await bench.run();

  const results = bench.tasks.map((t) => {
    // tinybench ≥3 nests stats under result.latency and result.throughput
    const r    = t.result as unknown as Record<string, unknown> | undefined;
    const lat  = (r?.latency  ?? {}) as Record<string, number>;
    const tput = (r?.throughput ?? {}) as Record<string, number>;
    const size = Number(t.name.match(/batch=(\d+)/)?.[1] ?? 0);
    const opsPerSec = tput.mean ?? 0;
    return {
      name:          t.name,
      batchSize:     size,
      opsPerSec:     parseFloat(opsPerSec.toFixed(4)),
      rowsPerSecond: parseFloat((opsPerSec * size).toFixed(2)),
      p50ms:         parseFloat((lat.p50 ?? 0).toFixed(3)),
      p99ms:         parseFloat((lat.p99 ?? 0).toFixed(3)),
      samples:       lat.samplesCount ?? 0,
    };
  });

  console.table(results.map(({ name, rowsPerSecond, p50ms, p99ms }) => ({
    name, rowsPerSecond, p50ms, p99ms,
  })));

  const output = { timestamp: new Date().toISOString(), results };
  writeFileSync("bench/results.json", JSON.stringify(output, null, 2));
  console.log("Results saved to bench/results.json");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
