import { fetchEventsSafe, getRpc, _resetRpcClients, EVENTS_PAGE_BUDGET } from '../rpc'

// Minimal RPC event — only the fields fetchEvents maps out of Api.EventResponse.
// We spy on the cached RPC server so the real request-building and cursor
// handling in fetchEvents run, while the network is replaced by a scripted
// response.
function rpcEvent(ledger: number, id: string): any {
  return {
    id,
    type: 'contract',
    ledger,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    contractId: undefined,
    txHash: `tx-${id}`,
    topic: [],
    value: {},
  }
}

describe('rpc paging — the cursor advances to the ledger actually covered', () => {
  beforeEach(() => {
    _resetRpcClients()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  function mockGetEvents(): any {
    return jest.spyOn(getRpc('testnet'), 'getEvents')
  }

  it('drains a full first page so the second page is ingested', async () => {
    const getEvents = mockGetEvents()
    const limit = 2
    getEvents
      .mockResolvedValueOnce({
        events: [rpcEvent(100, 'a'), rpcEvent(101, 'b')],
        latestLedger: 200,
        cursor: 'cursor-1',
      })
      .mockResolvedValueOnce({
        events: [rpcEvent(102, 'c')],
        latestLedger: 200,
        cursor: 'cursor-2',
      })

    const result = await fetchEventsSafe(100, 105, [], limit, undefined, 'testnet')

    expect(getEvents).toHaveBeenCalledTimes(2)
    // On the pre-fix code page 1 (exactly `limit` events) was treated as the
    // whole result and ledger 102 was silently dropped.
    expect(result.events.map((e) => e.ledger)).toEqual([100, 101, 102])
    // The second request continued from the cursor, not from startLedger.
    expect(getEvents.mock.calls[1][0]).toMatchObject({ cursor: 'cursor-1', limit })
    expect(getEvents.mock.calls[0][0]).toMatchObject({ startLedger: 100, limit })
  })

  it('never advances highestLedger past the endLedger it was given', async () => {
    const getEvents = mockGetEvents()
    getEvents.mockResolvedValue({
      events: [rpcEvent(100, 'a')],
      latestLedger: 500,
      cursor: 'cursor-1',
    })

    const result = await fetchEventsSafe(100, 120, [], 10, undefined, 'testnet')

    expect(result.highestLedger).toBe(120)
    expect(result.highestLedger).toBeLessThanOrEqual(120)
    // The raw network tip must never become the cursor.
    expect(result.highestLedger).not.toBe(500)
  })

  it('drops events above endLedger instead of reading un-settled ledgers', async () => {
    const getEvents = mockGetEvents()
    getEvents.mockResolvedValue({
      events: [rpcEvent(100, 'a'), rpcEvent(501, 'b')],
      latestLedger: 501,
      cursor: 'cursor-1',
    })

    const result = await fetchEventsSafe(100, 120, [], 10, undefined, 'testnet')

    expect(result.events.map((e) => e.ledger)).toEqual([100])
    expect(result.highestLedger).toBe(120)
  })

  it('stops at the page budget and only advances to the last covered event', async () => {
    const getEvents = mockGetEvents()
    let page = 0
    getEvents.mockImplementation(async () => {
      page += 1
      return {
        events: [rpcEvent(99 + page, `e${page}`)],
        latestLedger: 10_000,
        cursor: `cursor-${page}`,
      }
    })

    const result = await fetchEventsSafe(100, 10_000, [], 1, undefined, 'testnet')

    expect(getEvents).toHaveBeenCalledTimes(EVENTS_PAGE_BUDGET)
    expect(result.highestLedger).toBe(100 + EVENTS_PAGE_BUDGET - 1)
    expect(result.highestLedger).toBeLessThanOrEqual(10_000)
  })
})
