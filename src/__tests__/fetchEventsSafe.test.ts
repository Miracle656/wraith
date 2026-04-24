import { fetchEventsSafe } from '../rpc'

// Minimal mock event — only the fields fetchEvents maps from the RPC response.
// We pass pre-shaped RawEvent objects via our injected fetchFn, bypassing the
// real RPC.Server entirely.
function makeEvent(ledger: number, id: string) {
  return {
    id,
    type: 'contract',
    ledger,
    ledgerClosedAt: new Date().toISOString(),
    contractId: 'CABC123',
    txHash: 'tx' + id,
    topic: [] as any[],
    value: {} as any,
  }
}

function xdrError(): Error {
  return new Error('Failed to decode XDR: unknown type')
}

function networkError(): Error {
  return new Error('Network timeout')
}

// Convenience: build a mock fetchFn from a sequence of responses
function mockFetch(...calls: Array<() => Promise<any>>) {
  let i = 0
  return jest.fn(async () => {
    const fn = calls[i++]
    if (!fn) throw new Error('mockFetch: unexpected extra call')
    return fn()
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('fetchEventsSafe — bisection algorithm', () => {
  it('returns all events and correct highestLedger when no XDR error occurs', async () => {
    const fetch = mockFetch(() =>
      Promise.resolve({ events: [makeEvent(100, 'e1'), makeEvent(101, 'e2')], latestLedger: 105 })
    )

    const result = await fetchEventsSafe(100, 105, [], 10_000, fetch as any)

    expect(result.events).toHaveLength(2)
    expect(result.highestLedger).toBe(105)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('bisects on XDR error and returns events from both halves', async () => {
    // Call sequence: full(100–105) → XDR, lower(100–102) → ok, upper(103–105) → ok
    const fetch = mockFetch(
      () => Promise.reject(xdrError()),
      () => Promise.resolve({ events: [makeEvent(100, 'e1')], latestLedger: 102 }),
      () => Promise.resolve({ events: [makeEvent(104, 'e2')], latestLedger: 105 })
    )

    const result = await fetchEventsSafe(100, 105, [], 10_000, fetch as any)

    expect(result.events).toHaveLength(2)
    expect(result.events.map(e => e.ledger)).toEqual([100, 104])
    expect(result.highestLedger).toBe(105)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('isolates a single bad ledger and collects events from surrounding ledgers', async () => {
    // Range 100–104, ledger 102 is bad.
    // full(100–104) → XDR
    // lower(100–102) → XDR  → lower-lower(100–101) → ok, lower-upper(102–102) → XDR/skip
    // upper(103–104) → ok
    const fetch = mockFetch(
      () => Promise.reject(xdrError()),   // full 100–104
      () => Promise.reject(xdrError()),   // lower 100–102
      () => Promise.resolve({ events: [makeEvent(100, 'e1'), makeEvent(101, 'e2')], latestLedger: 101 }),  // 100–101
      () => Promise.reject(xdrError()),   // single 102–102 (skipped)
      () => Promise.resolve({ events: [makeEvent(103, 'e3'), makeEvent(104, 'e4')], latestLedger: 104 })   // upper 103–104
    )

    const result = await fetchEventsSafe(100, 104, [], 10_000, fetch as any)

    expect(result.events).toHaveLength(4)
    expect(result.events.map(e => e.ledger)).toEqual([100, 101, 103, 104])
    expect(result.highestLedger).toBe(104)
  })

  it('returns empty without infinite loop when the entire range fails with XDR errors', async () => {
    // 100–101: full → XDR, then both single ledgers also XDR → both skipped
    const fetch = jest.fn().mockRejectedValue(xdrError())

    const result = await fetchEventsSafe(100, 101, [], 10_000, fetch as any)

    expect(result.events).toHaveLength(0)
    expect(result.highestLedger).toBe(101)
    // 3 calls: full(100–101), lower(100–100), upper(101–101)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('re-throws non-XDR errors without bisecting', async () => {
    const fetch = mockFetch(() => Promise.reject(networkError()))

    await expect(fetchEventsSafe(100, 105, [], 10_000, fetch as any)).rejects.toThrow('Network timeout')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('re-throws non-XDR errors on single-ledger ranges', async () => {
    const fetch = mockFetch(() => Promise.reject(networkError()))

    await expect(fetchEventsSafe(100, 100, [], 10_000, fetch as any)).rejects.toThrow('Network timeout')
  })

  it('forwards contractIds to every fetchFn call', async () => {
    const fetch = jest.fn().mockResolvedValue({ events: [], latestLedger: 100 })
    const contracts = ['CABC123', 'CDEF456']

    await fetchEventsSafe(100, 100, contracts, 5_000, fetch as any)

    expect(fetch).toHaveBeenCalledWith(100, contracts, 5_000)
  })
})
