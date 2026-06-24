/**
 * GraphQL subscriptions with backpressure handling.
 *
 * This module implements real-time subscriptions for TokenTransfer and HostFnLog
 * events with per-client filtering and server-side backpressure management.
 *
 * Backpressure strategy:
 * - Each subscription maintains a bounded message queue (default 1000 messages)
 * - If a slow client falls behind, oldest messages are dropped (backpressure)
 * - Client is notified when backpressure events occur
 * - Server memory is protected by the queue size limit
 */

import { transferEmitter, TransferEvent } from "../events";
import { prisma } from "../db";
import type { HostFnRecord } from "../indexer/host-fn-log";

// ─── Configuration ────────────────────────────────────────────────────────────
const BACKPRESSURE_QUEUE_SIZE = 1000;
const BACKPRESSURE_CHECK_INTERVAL_MS = 100; // How often to warn about backpressure

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SubscriptionFilters {
  contracts?: string[]; // Filter by contract IDs
  senders?: string[]; // Filter by sender addresses
  recipients?: string[]; // Filter by recipient addresses
}

export interface TransferSubscriptionEvent {
  type: "transfer";
  data: TransferEvent & { displayAmount: string };
}

export interface BackpressureEvent {
  type: "backpressure";
  droppedCount: number;
  queueSize: number;
  message: string;
}

export type SubscriptionEvent = TransferSubscriptionEvent | BackpressureEvent;

// ─── HostFnLog Subscription Events ────────────────────────────────────────────

export interface HostFnLogSubscriptionEvent {
  type: "hostFnLog";
  data: HostFnRecord;
}

export interface HostFnLogBackpressureEvent {
  type: "backpressure";
  droppedCount: number;
  queueSize: number;
  message: string;
}

export type HostFnLogSubscriptionEventType =
  | HostFnLogSubscriptionEvent
  | HostFnLogBackpressureEvent;

// ─── Helper: Amount formatting ────────────────────────────────────────────────

const STROOPS = 10_000_000n;

function toDisplayAmount(amount: string): string {
  const raw = BigInt(amount);
  const abs = raw < 0n ? -raw : raw;
  const integer = abs / STROOPS;
  const remainder = abs % STROOPS;
  const sign = raw < 0n ? "-" : "";
  return `${sign}${integer}.${String(remainder).padStart(7, "0")}`;
}

// ─── Filter Matching ──────────────────────────────────────────────────────────

function matchesTransferFilters(
  transfer: TransferEvent,
  filters: SubscriptionFilters,
): boolean {
  if (filters.contracts && !filters.contracts.includes(transfer.contractId)) {
    return false;
  }

  if (
    filters.senders &&
    !filters.senders.includes(transfer.fromAddress ?? "")
  ) {
    return false;
  }

  if (
    filters.recipients &&
    !filters.recipients.includes(transfer.toAddress ?? "")
  ) {
    return false;
  }

  return true;
}

function matchesHostFnFilters(
  log: HostFnRecord,
  filters: SubscriptionFilters,
): boolean {
  if (filters.contracts && !filters.contracts.includes(log.contractId)) {
    return false;
  }

  // HostFnLog doesn't have sender/recipient, so skip address filters
  return true;
}

// ─── Transfer Subscriptions ───────────────────────────────────────────────────

/**
 * Create an async iterator that yields new TokenTransfer events in real-time,
 * with optional filtering and backpressure handling.
 *
 * @param filters - Optional filters for contract/sender/recipient
 * @returns AsyncIterator that yields SubscriptionEvent objects
 */
export async function* subscribeToTransfers(
  filters?: SubscriptionFilters,
): AsyncGenerator<SubscriptionEvent, void, unknown> {
  const queue: TransferEvent[] = [];
  let droppedCount = 0;
  let closed = false;
  let lastBackpressureWarning = 0;

  // Resolver for the next item to be yielded
  let resolve: ((value: TransferEvent | null) => void) | null = null;
  const waitForNext = (): Promise<TransferEvent | null> => {
    return new Promise((res) => {
      if (queue.length > 0) {
        res(queue.shift() ?? null);
      } else {
        resolve = res;
      }
    });
  };

  // Event handler: called whenever a new transfer is indexed
  const handleTransfer = (transfer: TransferEvent): void => {
    if (closed) return;

    // Check if this transfer matches the client's filters
    if (filters && !matchesTransferFilters(transfer, filters)) {
      return;
    }

    // Enforce backpressure: drop oldest message if queue is full
    if (queue.length >= BACKPRESSURE_QUEUE_SIZE) {
      queue.shift();
      droppedCount++;

      // Warn client periodically about backpressure
      const now = Date.now();
      if (now - lastBackpressureWarning > BACKPRESSURE_CHECK_INTERVAL_MS) {
        lastBackpressureWarning = now;
        if (resolve) {
          resolve(null); // Signal will be sent before next transfer
        }
      }
    } else {
      queue.push(transfer);
      if (resolve) {
        const cb = resolve;
        resolve = null;
        cb(queue.shift() ?? null);
      }
    }
  };

  // Attach handler to the global transfer emitter
  transferEmitter.on("transfer:new", handleTransfer);

  try {
    while (!closed) {
      // If we had backpressure, emit a warning event
      if (droppedCount > 0) {
        const dropped = droppedCount;
        droppedCount = 0;
        yield {
          type: "backpressure",
          droppedCount: dropped,
          queueSize: queue.length,
          message: `Backpressure: dropped ${dropped} messages. Consider adding more specific filters.`,
        };
      }

      const transfer = await waitForNext();
      if (transfer === null) {
        // Backpressure check signaled, loop to emit warning
        continue;
      }

      yield {
        type: "transfer",
        data: { ...transfer, displayAmount: toDisplayAmount(transfer.amount) },
      };
    }
  } finally {
    closed = true;
    transferEmitter.off("transfer:new", handleTransfer);
  }
}

// ─── HostFnLog Subscriptions ─────────────────────────────────────────────────

/**
 * Create an async iterator that yields new HostFnLog events in real-time,
 * with optional filtering and backpressure handling.
 *
 * HostFnLog events are persisted to the database and retrieved on demand.
 * This is a polling implementation that checks for new logs every interval.
 *
 * @param filters - Optional filters for contract
 * @param pollInterval - How often to check for new events (ms, default 1000)
 * @returns AsyncIterator that yields HostFnLogSubscriptionEventType objects
 */
export async function* subscribeToHostFnLogs(
  filters?: SubscriptionFilters,
  pollInterval: number = 1000,
): AsyncGenerator<HostFnLogSubscriptionEventType, void, unknown> {
  let closed = false;
  let lastId = 0; // Track the highest ID we've seen
  let droppedCount = 0;
  const queue: HostFnRecord[] = [];

  try {
    while (!closed) {
      // Fetch new logs since the last ID we've seen
      const newLogs = await prisma.hostFnLog.findMany({
        where: {
          id: { gt: lastId },
          ...(filters?.contracts && { contractId: { in: filters.contracts } }),
        },
        orderBy: { id: "asc" },
        take: 100, // Limit per query to avoid huge result sets
      });

      // Track dropped messages for backpressure
      if (queue.length >= BACKPRESSURE_QUEUE_SIZE) {
        const toDrop =
          newLogs.length - (BACKPRESSURE_QUEUE_SIZE - queue.length);
        if (toDrop > 0) {
          droppedCount += toDrop;
          newLogs.splice(0, toDrop);
        }
      }

      // Add valid logs to queue
      for (const log of newLogs) {
        queue.push(log);
        lastId = Math.max(lastId, log.id);
      }

      // Emit backpressure warning if needed
      if (droppedCount > 0) {
        const dropped = droppedCount;
        droppedCount = 0;
        yield {
          type: "backpressure",
          droppedCount: dropped,
          queueSize: queue.length,
          message: `Backpressure: dropped ${dropped} messages. Consider adding more specific filters.`,
        };
      }

      // Yield all queued logs
      while (queue.length > 0) {
        const log = queue.shift();
        if (log) {
          yield {
            type: "hostFnLog",
            data: log,
          };
        }
      }

      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  } finally {
    closed = true;
  }
}
