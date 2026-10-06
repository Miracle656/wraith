/**
 * #180 follow-up — the parallel path must commit the *minimum* ledger covered
 * across workers.
 *
 * Every worker used to return the identical network tip, so `Math.max` was
 * meaningless. Once fetchEventsSafe started reporting per-partition coverage, a
 * partition that hit the page budget returns a genuinely lower `highestLedger`
 * than one that drained cleanly — and taking the max skipped the truncated
 * partition's ledgers permanently, the exact failure #180 is about, on the
 * INGEST_WORKERS > 1 path.
 *
 * Workers fetch and batch through the injected `ParallelIo` seams (#203), so
 * this test scripts each partition's coverage directly instead of mocking the
 * RPC layer.
 */

jest.mock('../db', () => ({
  setLastIndexedLedger: jest.fn().mockResolvedValue(undefined),
}))

import { pollParallel, type ParallelIo } from '../indexer/parallel'
import { setLastIndexedLedger } from '../db'

const mockSetLastIndexedLedger = setLastIndexedLedger as jest.MockedFunction<typeof setLastIndexedLedger>

/** One worker per partition; `ledgers` is consumed in partition order. */
function scriptedIo(ledgers: number[]): { io: ParallelIo; fetchEvents: jest.Mock } {
  const fetchEvents = jest.fn()
  for (const ledger of ledgers) {
    fetchEvents.mockResolvedValueOnce({ events: [], highestLedger: ledger })
  }
  return {
    io: { fetchEvents, processBatch: jest.fn() } as unknown as ParallelIo,
    fetchEvents,
  }
}

describe('pollParallel — the committed cursor is the minimum covered ledger', () => {
  beforeEach(() => {
    mockSetLastIndexedLedger.mockReset()
    mockSetLastIndexedLedger.mockResolvedValue(undefined)
  })

  it('commits the truncated worker ledger, not the fully-drained one', async () => {
    // Two contract ids shard into two partitions (their char-code sums differ
    // in parity), so both workers run. One drains to the window end, one is cut
    // short by the page budget. The committed cursor must not skip the cut.
    const { io, fetchEvents } = scriptedIo([120, 105])

    const result = await pollParallel(['CA', 'CB'], 100, 120, 10, 2, 'testnet', io)

    expect(fetchEvents).toHaveBeenCalledTimes(2)
    expect(result.highestLedger).toBe(105)
    expect(mockSetLastIndexedLedger).toHaveBeenCalledWith(105, 'testnet')
  })

  it('clamps to toLedger and still progresses on an empty window', async () => {
    // Every worker reports 0 (nothing covered); the floor at fromLedger keeps
    // the loop moving instead of stalling on the same window forever.
    const { io } = scriptedIo([0, 0])

    const result = await pollParallel(['CA', 'CB'], 100, 120, 10, 2, 'testnet', io)

    expect(result.highestLedger).toBe(100)
    expect(mockSetLastIndexedLedger).toHaveBeenCalledWith(100, 'testnet')
  })
})
