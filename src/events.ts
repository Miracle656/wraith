import { EventEmitter } from "events";
import type { TransferRecord } from "./db";

// Singleton emitter for real-time transfer notifications.
// setMaxListeners(0) removes the default 10-listener cap — one listener per
// active WebSocket subscriber is expected.
export const transferEmitter = new EventEmitter();
transferEmitter.setMaxListeners(0);

export type TransferEvent = TransferRecord;

export function emitTransfer(transfer: TransferEvent): void {
  transferEmitter.emit("transfer:new", transfer);
}
