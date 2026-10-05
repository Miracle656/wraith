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
 */

jest.mock('../rpc', () => ({
  fetchEventsSafe: jest.fn(),
}))

jest.mock('../db', () => ({
  upsertTransfers: jest.fn().mockResolvedValue(0),
  setLastIndexedLedger: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../decoder', () => ({
  parseEvents: jest.fn(() => []),
}))

jest.mock('../events', () => ({
  emitTransfer: jest.fn(),
}))

import { pollParallel } from '../indexer/parallel'
import { fetchEventsSafe } from '../rpc'
import { setLastIndexedLedger } from '../db'

const mockFetchEventsSafe = fetchEventsSafe as jest.MockedFunction<typeof fetchEventsSafe>
const mockSetLastIndexedLedger = setLastIndexedLedger as jest.MockedFunction<typeof setLastIndexedLedger>

describe('pollParallel — the committed cursor is the minimum covered ledger', () => {
  beforeEach(() => {
    mockFetchEventsSafe.mockReset()
    mockSetLastIndexedLedger.mockReset()
    mockSetLastIndexedLedger.mockResolvedValue(undefined)
  })

  it('commits the truncated worker ledger, not the fully-drained one', async () => {
    // Two contract ids shard into two partitions (their char-code sums differ
    // in parity), so both workers run. One drains to the window end, one is cut
    // short by the page budget. The committed cursor must not skip the cut.
    mockFetchEventsSafe
      .mockResolvedValueOnce({ events: [], highestLedger: 120 }) // drained cleanly
      .mockResolvedValueOnce({ events: [], highestLedger: 105 }) // truncated

    const result = await pollParallel(['CA', 'CB'], 100, 120, 10, 2, 'testnet')

    expect(result.highestLedger).toBe(105)
    expect(mockSetLastIndexedLedger).toHaveBeenCalledWith(105, 'testnet')
  })

  it('clamps to toLedger and still progresses on an empty window', async () => {
    // Every worker reports 0 (nothing covered); the floor at fromLedger keeps
    // the loop moving instead of stalling on the same window forever.
    mockFetchEventsSafe.mockResolvedValue({ events: [], highestLedger: 0 })

    const result = await pollParallel(['CA', 'CB'], 100, 120, 10, 2, 'testnet')

    expect(result.highestLedger).toBe(100)
    expect(mockSetLastIndexedLedger).toHaveBeenCalledWith(100, 'testnet')
  })
})
