/**
 * Parallel partition ingest (#83).
 *
 * Shards the watched contract IDs by (sum-of-char-codes % N) so each worker
 * owns a stable, non-overlapping subset of contracts.  All workers issue their
 * own RPC calls and DB writes concurrently via Promise.all, giving roughly N×
 * throughput on multi-contract deployments.
 *
 * Ordering guarantee: events are ordered within each partition because every
 * worker processes its own ledger range sequentially with the same fromLedger /
 * toLedger window.  Cross-partition ordering is not guaranteed and is not
 * required by the data model (eventId is the canonical ordering key).
 *
 * This module only decides *how* events are fetched and sharded. *What* is done
 * with them lives in `processEventBatch` (./batch), which the caller injects, so
 * the sharded path cannot drift from the single-fetch path (#203).
 */

import type { RawEvent } from "../rpc";
import { resolveNetwork, type Network } from "../network";
import { setLastIndexedLedger } from "../db";
import { batchTotal, type BatchResult } from "./batch";

export const DEFAULT_WORKERS = 4;

/**
 * Deterministically distribute contract IDs across N buckets.
 * The same contractId always maps to the same bucket so ledger state is
 * consistent within a partition across poll cycles.
 */
export function partitionByContract(contractIds: string[], n: number): string[][] {
  const buckets: string[][] = Array.from({ length: n }, () => []);
  for (const id of contractIds) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash + id.charCodeAt(i)) | 0; // keep 32-bit integer
    }
    buckets[Math.abs(hash) % n].push(id);
  }
  return buckets.filter(b => b.length > 0);
}

interface WorkerResult {
  inserted: number;
  highestLedger: number;
}

/**
 * The two seams the caller provides. Both are required: a sharded run with no
 * `processBatch` is exactly the silent degradation this module used to have.
 */
export interface ParallelIo {
  fetchEvents: (
    fromLedger: number,
    toLedger: number,
    contractIds: string[],
    limit: number,
  ) => Promise<{ events: RawEvent[]; highestLedger: number }>;
  processBatch: (events: RawEvent[]) => Promise<BatchResult>;
}

async function runPartitionWorker(
  partition: string[],
  fromLedger: number,
  toLedger: number,
  batchSize: number,
  io: ParallelIo,
): Promise<WorkerResult> {
  const { events, highestLedger } = await io.fetchEvents(
    fromLedger,
    toLedger,
    partition,
    batchSize,
  );

  if (events.length === 0) {
    return { inserted: 0, highestLedger };
  }

  const inserted = batchTotal(await io.processBatch(events));
  return { inserted, highestLedger };
}

/**
 * Poll one ledger window across all contract partitions in parallel.
 *
 * @returns Total rows inserted (every record type), and the cursor to commit:
 * the **lowest** `highestLedger` across workers, clamped to
 * `[fromLedger, toLedger]`. A worker cut short by the page budget covered less
 * than the others, and the window cannot be considered indexed past the first
 * ledger someone failed to fully cover.
 */
export async function pollParallel(
  contractIds: string[],
  fromLedger: number,
  toLedger: number,
  batchSize: number,
  workerCount: number = DEFAULT_WORKERS,
  network: Network | undefined,
  io: ParallelIo,
): Promise<{ totalInserted: number; highestLedger: number }> {
  const net = resolveNetwork(network);
  const partitions = partitionByContract(contractIds, Math.min(workerCount, contractIds.length || 1));

  const results = await Promise.all(
    partitions.map(partition =>
      runPartitionWorker(partition, fromLedger, toLedger, batchSize, io),
    ),
  );

  const totalInserted = results.reduce((sum, r) => sum + r.inserted, 0);
  // The committed cursor is the *minimum* ledger covered across workers, not
  // the maximum. Before #180 every worker returned the identical network tip,
  // so `Math.max` was meaningless; now a partition that hit the page budget
  // returns a genuinely lower `highestLedger` than one that drained cleanly, and
  // taking the max would skip the truncated partition's ledgers forever.
  //
  // Seeding the reduce with `toLedger` also clamps to the requested window (the
  // parallel path has no separate clamp), and the floor at `fromLedger` keeps
  // an empty window making progress instead of stalling.
  const highestLedger = Math.max(
    fromLedger,
    results.reduce((min, r) => Math.min(min, r.highestLedger), toLedger),
  );

  await setLastIndexedLedger(highestLedger, net);

  if (totalInserted > 0) {
    console.log(
      `[parallel/${net}] ${partitions.length} workers processed ${totalInserted} new records (ledger ${highestLedger})`,
    );
  }

  return { totalInserted, highestLedger };
}
