import { fetchEventsSafe, isXdrDecodeError } from '../rpc'
import { ledgersSkippedTotal } from '../metrics'

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

// A transient "unknown" error that is NOT an XDR error — must propagate
// so the retry layer can reattempt instead of silently skipping the ledger.
// Issue #183 calls this out as the bug: bare "unknown" used to match the
// old substring predicate and silently skip ledgers.
function bareUnknownError(): Error {
  return new Error('unknown error')
}

function unknownHostError(): Error {
  // Real Node DNS blip — getaddrinfo ENOTFOUND, body mentions "unknown"
  // because "unknown" is part of "unknown host".
  return new Error('getaddrinfo ENOTFOUND rpc.example.com unknown host')
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

    // fetchEventsSafe now forwards the network as a 4th argument (#161);
    // undefined here means "the configured network", the single-network default.
    expect(fetch).toHaveBeenCalledWith(100, contracts, 5_000, undefined)
  })
})

// ── New tests for #183 — "unknown" substring is too greedy ───────────────────
describe('fetchEventsSafe — issue #183: stop treating any "unknown" as XDR', () => {
  beforeEach(() => {
    // Reset the skipped-ledger counter so each test sees only its own skips.
    ledgersSkippedTotal.reset()
  })

  it('re-throws a bare "unknown error" instead of skipping the ledger', async () => {
    // Before #183, this would have been silently skipped (msg.includes("unknown") matched).
    // After #183, it must propagate so the retry layer can reattempt.
    const fetch = mockFetch(() => Promise.reject(bareUnknownError()))

    await expect(fetchEventsSafe(100, 100, [], 10_000, fetch as any)).rejects.toThrow('unknown error')
    expect(fetch).toHaveBeenCalledTimes(1)
    // No skips recorded — the error propagated rather than being swallowed.
    const skipped = await ledgersSkippedTotal.get()
    expect(skipped.values.length).toBe(0)
  })

  it('re-throws "getaddrinfo ENOTFOUND … unknown host" network blips', async () => {
    // Network blips should never cause silent data loss — they should propagate
    // so the retry layer can reattempt. Previously, "unknown host" matched the
    // old "unknown" substring and the ledger was silently skipped.
    const fetch = mockFetch(() => Promise.reject(unknownHostError()))

    await expect(fetchEventsSafe(100, 100, [], 10_000, fetch as any)).rejects.toThrow('getaddrinfo ENOTFOUND')
    const skipped = await ledgersSkippedTotal.get()
    expect(skipped.values.length).toBe(0)
  })

  it('still skips a genuine XDR decode error on single-ledger range', async () => {
    // Real XDR errors must still bisect/skip — the fix is about narrowing
    // the predicate, not removing the skip behaviour entirely.
    const fetch = mockFetch(() => Promise.reject(xdrError()))

    const result = await fetchEventsSafe(100, 100, [], 10_000, fetch as any)

    expect(result.events).toHaveLength(0)
    expect(result.highestLedger).toBe(100)
    // Skip metric now incremented — the skip is visible rather than only logged.
    const skipped = await ledgersSkippedTotal.get()
    expect(skipped.values.length).toBe(1)
    // The label is whatever the current default network is (mainnet in prod, testnet in tests).
    expect(skipped.values[0].labels.network).toMatch(/^(mainnet|testnet)$/)
    expect(skipped.values[0].value).toBe(1)
  })

  it('still bisects genuine XDR errors on multi-ledger ranges', async () => {
    // full(100–105) → XDR, lower(100–102) → ok, upper(103–105) → ok
    const fetch = mockFetch(
      () => Promise.reject(xdrError()),
      () => Promise.resolve({ events: [makeEvent(100, 'e1')], latestLedger: 102 }),
      () => Promise.resolve({ events: [makeEvent(104, 'e2')], latestLedger: 105 })
    )

    const result = await fetchEventsSafe(100, 105, [], 10_000, fetch as any)

    expect(result.events).toHaveLength(2)
    expect(result.highestLedger).toBe(105)
    expect(fetch).toHaveBeenCalledTimes(3)
    // No skips — both halves succeeded after bisection.
    const skipped = await ledgersSkippedTotal.get()
    expect(skipped.values.length).toBe(0)
  })

  it('increments skipped-ledger metric for every XDR-skipped ledger', async () => {
    // Range 100–101, both ledgers fail with XDR → both skipped.
    const fetch = jest.fn().mockRejectedValue(xdrError())

    await fetchEventsSafe(100, 101, [], 10_000, fetch as any)

    expect(fetch).toHaveBeenCalledTimes(3) // full + lower + upper
    // Two single-ledger skips, each increments the counter — total value = 2.
    const skipped = await ledgersSkippedTotal.get()
    const total = skipped.values.reduce((sum, v) => sum + v.value, 0)
    expect(total).toBe(2)
  })
})

// ── isXdrDecodeError unit tests ──────────────────────────────────────────────
describe('isXdrDecodeError', () => {
  it('returns true for real XDR decoder errors', () => {
    expect(isXdrDecodeError(new Error('Failed to decode XDR: unknown type'))).toBe(true)
    expect(isXdrDecodeError(new Error('TypeError: 3 is not a valid XDR integer'))).toBe(true)
    expect(isXdrDecodeError(new Error('decode xdr failed at byte 47'))).toBe(true)
  })

  it('returns true for Soroban-specific "unknown" type errors', () => {
    expect(isXdrDecodeError(new Error('unknown scval type 17'))).toBe(true)
    expect(isXdrDecodeError(new Error('unknown scaddress type 3'))).toBe(true)
    expect(isXdrDecodeError(new Error('unknown soroban val'))).toBe(true)
  })

  it('returns false for bare "unknown error"', () => {
    expect(isXdrDecodeError(new Error('unknown error'))).toBe(false)
  })

  it('returns false for "unknown host" network blips', () => {
    expect(isXdrDecodeError(new Error('getaddrinfo ENOTFOUND rpc.example.com unknown host'))).toBe(false)
  })

  it('returns false for provider 5xx bodies', () => {
    expect(isXdrDecodeError(new Error('503 Service Unavailable'))).toBe(false)
    expect(isXdrDecodeError(new Error('502 Bad Gateway'))).toBe(false)
  })

  it('returns false for plain network errors', () => {
    expect(isXdrDecodeError(new Error('Network timeout'))).toBe(false)
    expect(isXdrDecodeError(new Error('fetch failed'))).toBe(false)
    expect(isXdrDecodeError(new Error('ECONNRESET'))).toBe(false)
  })

  it('returns false for empty / nullish inputs without throwing', () => {
    expect(isXdrDecodeError(null)).toBe(false)
    expect(isXdrDecodeError(undefined)).toBe(false)
    expect(isXdrDecodeError('')).toBe(false)
    expect(isXdrDecodeError({})).toBe(false)
    expect(isXdrDecodeError(42)).toBe(false)
  })

  it('case-insensitive — XDR vs xdr', () => {
    expect(isXdrDecodeError(new Error('failed to decode xdr'))).toBe(true)
    expect(isXdrDecodeError(new Error('XDR decode failed'))).toBe(true)
    expect(isXdrDecodeError(new Error('Decode XDR'))).toBe(true)
  })
})
