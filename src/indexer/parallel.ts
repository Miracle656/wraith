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
 */

import { fetchEventsSafe } from "../rpc";
import { parseEvents } from "../decoder";
import { upsertTransfers, setLastIndexedLedger } from "../db";
import { emitTransfer } from "../events";

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

async function runPartitionWorker(
  partition: string[],
  fromLedger: number,
  toLedger: number,
  batchSize: number,
): Promise<WorkerResult> {
  const { events, highestLedger } = await fetchEventsSafe(
    fromLedger,
    toLedger,
    partition,
    batchSize,
  );

  if (events.length === 0) {
    return { inserted: 0, highestLedger };
  }

  const records = parseEvents(events);
  const inserted = await upsertTransfers(records);

  if (inserted > 0) {
    records.forEach(emitTransfer);
  }

  return { inserted, highestLedger };
}

/**
 * Poll one ledger window across all contract partitions in parallel.
 *
 * @returns Total rows inserted and the highest ledger seen across all workers.
 */
export async function pollParallel(
  contractIds: string[],
  fromLedger: number,
  toLedger: number,
  batchSize: number,
  workerCount: number = DEFAULT_WORKERS,
): Promise<{ totalInserted: number; highestLedger: number }> {
  const partitions = partitionByContract(contractIds, Math.min(workerCount, contractIds.length || 1));

  const results = await Promise.all(
    partitions.map(partition =>
      runPartitionWorker(partition, fromLedger, toLedger, batchSize),
    ),
  );

  const totalInserted = results.reduce((sum, r) => sum + r.inserted, 0);
  const highestLedger = results.reduce(
    (max, r) => Math.max(max, r.highestLedger),
    fromLedger,
  );

  await setLastIndexedLedger(highestLedger);

  if (totalInserted > 0) {
    console.log(
      `[parallel] ${partitions.length} workers processed ${totalInserted} new records (ledger ${highestLedger})`,
    );
  }

  return { totalInserted, highestLedger };
}
