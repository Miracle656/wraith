import "dotenv/config";
import { createSourceSwitcherWithConfig, type SourceSwitcher } from "../indexer/sources";
import { fetchEventsSafe, validateNetworkConfig } from "../rpc";
import { parseEvents } from "../decoder";
import {
  upsertTransfers,
  upsertNftTransfers,
  getBackfillCursor,
  setBackfillCursor,
  clearBackfillCursor,
  type BackfillCursorState,
  prisma,
} from "../db";
import { upsertHostFnLogs, parseHostFnEvent, type HostFnRecord } from "../indexer/host-fn-log";
import { isNftTransferEvent, parseNftEvents } from "../ingester/nft";

const DEFAULT_CHUNK_SIZE = 64;
const DEFAULT_CONCURRENCY = 4;
const BATCH_SIZE = parseInt(process.env.EVENTS_BATCH_SIZE ?? "10000", 10);

export interface BackfillOptions {
  fromLedger: number;
  toLedger: number;
  chunkSize?: number;
  concurrency?: number;
  signal?: AbortSignal;
  force?: boolean;
}

export interface Chunk {
  start: number;
  end: number;
}

export function chunkRange(from: number, to: number, chunkSize: number): Chunk[] {
  if (from >= to) return [];
  const chunks: Chunk[] = [];
  for (let i = from; i < to; i += chunkSize) {
    chunks.push({ start: i, end: Math.min(i + chunkSize, to) });
  }
  return chunks;
}

function resolveContractIds(): string[] {
  const raw =
    process.env.SAC_CONTRACT_IDS ||
    process.env.CONTRACT_IDS ||
    "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function createSource(): SourceSwitcher {
  return createSourceSwitcherWithConfig({
    horizonUrl: process.env.HORIZON_URL,
    horizonEventsPath: process.env.HORIZON_EVENTS_PATH,
    fetchImpl: (globalThis as {
      fetch?: (input: string, init?: Record<string, unknown>) => Promise<{
        ok: boolean; status: number; json(): Promise<unknown>;
      }>;
    }).fetch as (
      input: string,
      init?: { headers?: Record<string, string> }
    ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
  });
}

async function processChunk(
  chunk: Chunk,
  contracts: string[],
  source: SourceSwitcher,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) return 0;

  const { events } = await source.fetchEvents(
    chunk.start,
    chunk.end,
    contracts,
    BATCH_SIZE,
  );

  if (events.length === 0) return 0;

  const relevant = events.filter(
    (e) => e.ledger >= chunk.start && e.ledger < chunk.end,
  );
  if (relevant.length === 0) return 0;

  const fungible = relevant.filter((e) => !isNftTransferEvent(e));
  const nft = relevant.filter((e) => isNftTransferEvent(e));

  let totalInserted = 0;

  if (fungible.length > 0) {
    try {
      const records = parseEvents(fungible);
      if (records.length > 0) {
        const inserted = await upsertTransfers(records);
        totalInserted += inserted;
      }
    } catch (err) {
      console.error(`[backfill] Fungible parse error in chunk ${chunk.start}-${chunk.end}:`, err);
    }
  }

  if (nft.length > 0) {
    try {
      const parsed = parseNftEvents(nft);
      if (parsed.length > 0) {
        const inserted = await upsertNftTransfers(parsed.map((p) => p.record));
        totalInserted += inserted;
      }
    } catch (err) {
      console.error(`[backfill] NFT parse error in chunk ${chunk.start}-${chunk.end}:`, err);
    }
  }

  try {
    const hostFnRecords = relevant
      .map((e) => {
        try { return parseHostFnEvent(e); } catch { return null; }
      })
      .filter((r): r is HostFnRecord => r !== null);
    if (hostFnRecords.length > 0) {
      await upsertHostFnLogs(hostFnRecords);
    }
  } catch (err) {
    console.error(`[backfill] HostFn log error in chunk ${chunk.start}-${chunk.end}:`, err);
  }

  return totalInserted;
}

export async function runBackfill(options: BackfillOptions): Promise<void> {
  const {
    fromLedger,
    toLedger,
    chunkSize = DEFAULT_CHUNK_SIZE,
    concurrency = DEFAULT_CONCURRENCY,
    signal,
    force,
  } = options;

  validateNetworkConfig();

  const contracts = resolveContractIds();

  let cursor = await getBackfillCursor();
  if (cursor) {
    if (cursor.startLedger === fromLedger && cursor.endLedger === toLedger) {
      if (cursor.nextLedger >= toLedger) {
        console.log("[backfill] Range already fully processed.");
        await clearBackfillCursor();
        return;
      }
      console.log(
        `[backfill] Resuming from cursor: nextLedger=${cursor.nextLedger} (${fromLedger} → ${toLedger})`,
      );
    } else if (force) {
      console.log(
        `[backfill] Forcing new range ${fromLedger}→${toLedger} (cursor was ${cursor.startLedger}→${cursor.endLedger})`,
      );
      cursor = { startLedger: fromLedger, endLedger: toLedger, nextLedger: fromLedger };
    } else {
      console.warn(
        `[backfill] Existing cursor (${cursor.startLedger}→${cursor.endLedger}) differs from requested range ` +
        `(${fromLedger}→${toLedger}). Use --force to override.`,
      );
      return;
    }
  } else {
    cursor = { startLedger: fromLedger, endLedger: toLedger, nextLedger: fromLedger };
  }

  const source = createSource();
  const chunks = chunkRange(cursor.nextLedger, toLedger, chunkSize);

  if (chunks.length === 0) {
    console.log("[backfill] No chunks to process.");
    await clearBackfillCursor();
    return;
  }

  console.log(
    `[backfill] Processing ${chunks.length} chunks (size=${chunkSize}, concurrency=${concurrency})`,
    contracts.length > 0 ? `contracts=[${contracts.join(",")}]` : "(all contracts)",
  );

  let totalInserted = 0;
  const totalChunks = chunks.length;

  for (let i = 0; i < chunks.length; i += concurrency) {
    if (signal?.aborted) {
      console.log("[backfill] Aborting — signal received.");
      return;
    }

    const wave = chunks.slice(i, i + concurrency);
    const results = await Promise.all(
      wave.map((c) =>
        processChunk(c, contracts, source, signal).catch((err) => {
          console.error(`[backfill] Chunk ${c.start}-${c.end} failed:`, err);
          return 0;
        }),
      ),
    );

    const waveInserted = results.reduce((s, v) => s + v, 0);
    totalInserted += waveInserted;

    const lastChunk = wave[wave.length - 1];
    cursor.nextLedger = lastChunk.end;
    await setBackfillCursor(cursor);

    const pct = ((lastChunk.end - fromLedger) / (toLedger - fromLedger) * 100).toFixed(1);
    const waveNum = Math.floor(i / concurrency) + 1;
    console.log(
      `[backfill] Wave ${waveNum} done — ledger ${lastChunk.end} (${pct}%), ${totalInserted} events inserted`,
    );
  }

  console.log(
    `[backfill] Complete — ${totalInserted} events inserted across ledgers ${fromLedger}→${toLedger}`,
  );

  await clearBackfillCursor();
  await prisma.$disconnect();
}
