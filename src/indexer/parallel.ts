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
import { resolveNetwork, type Network } from "../network";
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
  network: Network,
): Promise<WorkerResult> {
  const { events, highestLedger } = await fetchEventsSafe(
    fromLedger,
    toLedger,
    partition,
    batchSize,
    undefined,
    network,
  );

  if (events.length === 0) {
    return { inserted: 0, highestLedger };
  }

  const records = parseEvents(events);
  const inserted = await upsertTransfers(records, network);

  if (inserted > 0) {
    records.forEach((record) => emitTransfer(record, network));
  }

  return { inserted, highestLedger };
}

/**
 * Poll one ledger window across all contract partitions in parallel.
 *
 * @returns Total rows inserted and the *lowest* ledger every partition
 *   actually covered — the only value safe to commit as the next cursor.
 */
export async function pollParallel(
  contractIds: string[],
  fromLedger: number,
  toLedger: number,
  batchSize: number,
  workerCount: number = DEFAULT_WORKERS,
  network?: Network,
): Promise<{ totalInserted: number; highestLedger: number }> {
  const net = resolveNetwork(network);
  const partitions = partitionByContract(contractIds, Math.min(workerCount, contractIds.length || 1));

  const results = await Promise.all(
    partitions.map(partition =>
      runPartitionWorker(partition, fromLedger, toLedger, batchSize, net),
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
