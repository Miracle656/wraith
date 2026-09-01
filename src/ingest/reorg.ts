import type { PrismaClient } from "@prisma/client";
import { getLastIndexedLedger, setLastIndexedLedger, rollbackToLedger } from "../db";

type LedgerEntry = {
  sequence: number;
  hash: string;
  parentHash: string;
  closedAt: string | Date;
};

export class ReorgHandler {
  private buffer: LedgerEntry[] = [];
  private maxBuffer: number;

  constructor(maxBuffer = 128) {
    this.maxBuffer = maxBuffer;
  }

  // Record a ledger into the in-memory buffer (keeps recent N entries)
  record(entry: LedgerEntry) {
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
  }

  // Find ledger sequence by hash in the buffer
  findByHash(hash: string): number | null {
    const found = this.buffer.find((e) => e.hash === hash);
    return found ? found.sequence : null;
  }

  // Main handler called when a new ledger is observed.
  // - If parent hash matches current tip, simply record and advance state.
  // - If mismatch, attempt to find the canonical parent in buffer. If found,
  //   roll back to that ledger, otherwise fall back to previous sequence.
  // After rollback, calls the provided reingest function to replay canonical ledgers.
  async handleLedger(entry: LedgerEntry, reingestFn: (from: number, to: number) => Promise<void>) {
    // Quick path: nothing indexed yet
    const lastIndexed = await getLastIndexedLedger();

    // Tip hash is last buffer entry (if any)
    const tip = this.buffer.length ? this.buffer[this.buffer.length - 1] : null;

    if (!tip) {
      // first ledger observed - record and persist ledger number
      this.record(entry);
      await setLastIndexedLedger(entry.sequence);
      return { action: "advance", ledger: entry.sequence };
    }

    // If parent matches tip, normal extension
    if (entry.parentHash === tip.hash) {
      this.record(entry);
      await setLastIndexedLedger(entry.sequence);
      return { action: "advance", ledger: entry.sequence };
    }

    // Divergence detected
    console.warn(
      `[reorg] Divergence detected: incoming ${entry.sequence} parent ${entry.parentHash} != tip ${tip.sequence} ${tip.hash}`
    );

    const matchedSequence = this.findByHash(entry.parentHash);
    const rollbackTarget = matchedSequence ?? entry.sequence - 1;

    // Perform atomic rollback in DB
    await rollbackToLedger(rollbackTarget);

    // Trim buffer to the rollback target
    this.buffer = this.buffer.filter((e) => e.sequence <= rollbackTarget);

    // Update lastIndexedLedger in memory and DB
    await setLastIndexedLedger(rollbackTarget);

    // Re-ingest canonical branch: from rollbackTarget+1 up to incoming sequence (inclusive)
    const from = rollbackTarget + 1;
    const to = entry.sequence;

    console.log(`[reorg] Re-ingesting canonical branch ${from}..${to}`);
    await reingestFn(from, to);

    // After successful re-ingest record the incoming ledger(s) into buffer
    // For simplicity assume reingestFn calls handleLedger for intermediate ledgers,
    // but ensure incoming ledger is recorded if not present.
    if (!this.buffer.find((e) => e.sequence === entry.sequence)) {
      this.record(entry);
    }

    await setLastIndexedLedger(to);

    return { action: "reorg", rolledBackTo: rollbackTarget, reingestedTo: to };
  }
}

export default ReorgHandler;
