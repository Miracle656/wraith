import { fetchEventsSafe, isXdrError } from '../rpc'
import { registry, _resetMetrics } from '../metrics'

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

// The SDK's XDR codec reports "unknown <EnumName> member for value <n>" when a
// ledger uses a type the compiled-in enum does not know yet.
function unknownXdrTypeError(): Error {
  return new Error('unknown SCValType member for value 9')
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

  // "unknown" alone is not a decode failure. Matching it made every transient
  // error indistinguishable from an undecodable ledger, and the indexer answered
  // by skipping the ledger and moving the cursor past it — permanent, silent
  // data loss on what is usually a retryable blip.
  it('does not treat a bare "unknown error" as an XDR error', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('unknown error'))

    await expect(fetchEventsSafe(100, 100, [], 10_000, fetch as any)).rejects.toThrow('unknown error')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not bisect a range that failed with "unknown error"', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('unknown error'))

    await expect(fetchEventsSafe(100, 105, [], 10_000, fetch as any)).rejects.toThrow('unknown error')
    // One call: bisecting would have retried the halves of the range.
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not treat an unknown-host DNS failure as an XDR error', async () => {
    const fetch = jest.fn().mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND rpc.example.com unknown host')
    )

    await expect(fetchEventsSafe(100, 100, [], 10_000, fetch as any)).rejects.toThrow('ENOTFOUND')
  })

  it('does not treat a provider 5xx body containing "unknown" as an XDR error', async () => {
    const fetch = jest.fn().mockRejectedValue(
      new Error('Request failed with status code 503: upstream returned an unknown error')
    )

    await expect(fetchEventsSafe(100, 105, [], 10_000, fetch as any)).rejects.toThrow('503')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('still bisects and skips a ledger the SDK cannot decode at all', async () => {
    // The SDK reports a newer XDR type as an unknown enum member rather than
    // mentioning XDR by name; that is the case the skip path exists for.
    const fetch = mockFetch(
      () => Promise.reject(unknownXdrTypeError()),  // full 100–104
      () => Promise.reject(unknownXdrTypeError()),  // lower 100–102
      () => Promise.resolve({ events: [makeEvent(100, 'e1'), makeEvent(101, 'e2')], latestLedger: 101 }),
      () => Promise.reject(unknownXdrTypeError()),  // single 102–102 (skipped)
      () => Promise.resolve({ events: [makeEvent(103, 'e3'), makeEvent(104, 'e4')], latestLedger: 104 })
    )

    const result = await fetchEventsSafe(100, 104, [], 10_000, fetch as any)

    expect(result.events.map(e => e.ledger)).toEqual([100, 101, 103, 104])
    expect(result.highestLedger).toBe(104)
  })

  it('forwards contractIds to every fetchFn call', async () => {
    const fetch = jest.fn().mockResolvedValue({ events: [], latestLedger: 100 })
    const contracts = ['CABC123', 'CDEF456']

    await fetchEventsSafe(100, 100, contracts, 5_000, fetch as any)

    // fetchEventsSafe now forwards the network as a 4th argument (#161);
    // undefined here means "the configured network", the single-network default.
    expect(fetch).toHaveBeenCalledWith(100, contracts, 5_000, undefined)
  })
})

// ── Skipped-ledger metric ─────────────────────────────────────────────────────
// A skipped ledger is permanent data loss, and until now the only trace of one
// was a console.warn line that scrolls off the terminal.
describe('fetchEventsSafe — ledgers_skipped_total', () => {
  beforeEach(() => {
    _resetMetrics()
  })

  // prom-client omits a labelled series entirely until it is first observed, so
  // "no skips" is the absence of the series, not a zero.
  function exposition(): Promise<string> {
    return registry.metrics()
  }

  it('counts each ledger actually skipped', async () => {
    // 100–101: full → XDR, then both single ledgers → XDR → both skipped.
    const fetch = jest.fn().mockRejectedValue(xdrError())

    const result = await fetchEventsSafe(100, 101, [], 10_000, fetch as any, 'testnet')

    expect(result.events).toHaveLength(0)
    expect(result.highestLedger).toBe(101)
    expect(await exposition()).toContain('ledgers_skipped_total{network="testnet"} 2')
  })

  it('does not count a bisection that never gives up a ledger', async () => {
    // full → XDR, both halves decode cleanly: the range was searched, not skipped.
    const fetch = mockFetch(
      () => Promise.reject(xdrError()),
      () => Promise.resolve({ events: [makeEvent(100, 'e1')], latestLedger: 102 }),
      () => Promise.resolve({ events: [makeEvent(104, 'e2')], latestLedger: 105 })
    )

    const result = await fetchEventsSafe(100, 105, [], 10_000, fetch as any, 'testnet')

    expect(result.events).toHaveLength(2)
    expect(await exposition()).not.toContain('ledgers_skipped_total{')
  })

  it('counts a single skipped ledger inside a range once, not once per bisection', async () => {
    // 100–104 with only ledger 102 bad: three bisections, one skip.
    const fetch = mockFetch(
      () => Promise.reject(xdrError()),   // full 100–104
      () => Promise.reject(xdrError()),   // lower 100–102
      () => Promise.resolve({ events: [makeEvent(100, 'e1'), makeEvent(101, 'e2')], latestLedger: 101 }),
      () => Promise.reject(xdrError()),   // single 102–102 (skipped)
      () => Promise.resolve({ events: [makeEvent(103, 'e3'), makeEvent(104, 'e4')], latestLedger: 104 })
    )

    await fetchEventsSafe(100, 104, [], 10_000, fetch as any, 'testnet')

    expect(await exposition()).toContain('ledgers_skipped_total{network="testnet"} 1')
  })

  it('counts nothing when a non-XDR error propagates', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('unknown error'))

    await expect(fetchEventsSafe(100, 100, [], 10_000, fetch as any, 'testnet')).rejects.toThrow('unknown error')

    expect(await exposition()).not.toContain('ledgers_skipped_total{')
  })

  it('labels skips by network and never by ledger', async () => {
    const fetch = jest.fn().mockRejectedValue(xdrError())

    await fetchEventsSafe(7_000_000, 7_000_000, [], 10_000, fetch as any, 'mainnet')

    const text = await exposition()
    expect(text).toContain('ledgers_skipped_total{network="mainnet"} 1')
    expect(text).not.toContain('7000000')
  })
})

// ── The predicate itself ──────────────────────────────────────────────────────
describe('isXdrError', () => {
  it.each([
    'Failed to decode XDR: unknown type',
    'unknown SCValType member for value 9',
    'Bad union switch: 12',
    'invalid XDR contract typecast - source buffer not entirely consumed',
    'attempt to read outside the boundary of the buffer',
    'exceeded max decoding depth',
    '5 is not a value of any member of SCValType',
  ])('recognises the decoder’s own failure: %s', (message) => {
    expect(isXdrError(new Error(message))).toBe(true)
  })

  it.each([
    'unknown error',
    'getaddrinfo ENOTFOUND rpc.example.com unknown host',
    'Network timeout',
    'Request failed with status code 503: upstream returned an unknown error',
    'ledger 102 unknown',
    'ENOTFOUND',
  ])('rejects a non-decode error: %s', (message) => {
    expect(isXdrError(new Error(message))).toBe(false)
  })

  it('handles a thrown non-Error without throwing itself', () => {
    expect(isXdrError('Failed to decode XDR')).toBe(true)
    expect(isXdrError('unknown error')).toBe(false)
    expect(isXdrError(undefined)).toBe(false)
    expect(isXdrError(null)).toBe(false)
  })
})
