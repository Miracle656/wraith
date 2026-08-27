import { EventEmitter } from "events";
import type { TransferRecord } from "./db";
import type { HostFnRecord } from "./indexer/host-fn-log";

// Singleton emitter for real-time transfer notifications.
// setMaxListeners(0) removes the default 10-listener cap — one listener per
// active WebSocket subscriber is expected.
export const transferEmitter = new EventEmitter();
transferEmitter.setMaxListeners(0);

export type TransferEvent = TransferRecord;

export function emitTransfer(transfer: TransferEvent): void {
  transferEmitter.emit("transfer:new", transfer);
}

// Singleton emitter for real-time host-fn log notifications (GraphQL
// subscriptions, #99). Mirrors transferEmitter above.
export const hostFnLogEmitter = new EventEmitter();
hostFnLogEmitter.setMaxListeners(0);

export type HostFnLogEvent = HostFnRecord;

export function emitHostFnLog(log: HostFnLogEvent): void {
  hostFnLogEmitter.emit("hostfnlog:new", log);
}

/**
 * Turn an EventEmitter channel into a pull-based AsyncIterableIterator, the
 * shape GraphQL subscription resolvers require.
 *
 * Bounds memory for a slow consumer: once more than `maxQueue` events have
 * piled up waiting to be pulled, the oldest queued event is dropped so a
 * stalled subscriber can never grow the queue unboundedly.
 */
export function eventsToAsyncIterator<T>(
  emitter: EventEmitter,
  eventName: string,
  maxQueue = 100
): AsyncIterableIterator<T> {
  const pullQueue: Array<(result: IteratorResult<T>) => void> = [];
  const pushQueue: T[] = [];
  let listening = true;

  const pushValue = (value: T) => {
    if (pullQueue.length > 0) {
      const resolve = pullQueue.shift()!;
      resolve({ value, done: false });
      return;
    }

    pushQueue.push(value);
    if (pushQueue.length > maxQueue) {
      pushQueue.shift();
    }
  };

  emitter.on(eventName, pushValue);

  const stop = () => {
    if (!listening) return;
    listening = false;
    emitter.off(eventName, pushValue);
    while (pullQueue.length > 0) {
      pullQueue.shift()!({ value: undefined as unknown as T, done: true });
    }
  };

  const iterator: AsyncIterableIterator<T> = {
    next(): Promise<IteratorResult<T>> {
      if (pushQueue.length > 0) {
        return Promise.resolve({ value: pushQueue.shift()!, done: false });
      }
      if (!listening) {
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      }
      return new Promise((resolve) => pullQueue.push(resolve));
    },
    return(): Promise<IteratorResult<T>> {
      stop();
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    },
    throw(err): Promise<IteratorResult<T>> {
      stop();
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  return iterator;
}

/**
 * Wrap an async iterator so only values matching `predicate` are yielded,
 * used to apply subscription arguments (e.g. contractId) without adding a
 * dedicated listener per filter combination.
 */
export function filterAsyncIterator<T>(
  iterator: AsyncIterableIterator<T>,
  predicate: (value: T) => boolean
): AsyncIterableIterator<T> {
  const filtered: AsyncIterableIterator<T> = {
    async next(): Promise<IteratorResult<T>> {
      while (true) {
        const result = await iterator.next();
        if (result.done || predicate(result.value)) {
          return result;
        }
      }
    },
    return(value?: unknown): Promise<IteratorResult<T>> {
      return iterator.return
        ? (iterator.return(value) as Promise<IteratorResult<T>>)
        : Promise.resolve({ value: undefined as unknown as T, done: true });
    },
    throw(err): Promise<IteratorResult<T>> {
      return iterator.throw
        ? iterator.throw(err)
        : Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return filtered;
    },
  };

  return filtered;
}
