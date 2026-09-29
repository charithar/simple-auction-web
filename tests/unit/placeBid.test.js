import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// placeBid's handling of refused bids, with Firestore scripted: `denials` is how
// many commits the "server" refuses, `settingsNow` what a server read of
// settings/auction returns. The emulator can't time a sub-second pause reliably.
const state = { denials: 0, commits: 0, settingsNow: null, item: null, readsRefused: false }
vi.mock('firebase/firestore', () => ({
  doc: (db, ...path) => ({ path: path.join('/') }),
  serverTimestamp: () => 'server-time',
  getDocFromServer: vi.fn(async (ref) => {
    if (state.readsRefused) throw Object.assign(new Error('denied'), { code: 'permission-denied' })
    return { data: () => (ref.path === 'settings/auction' ? state.settingsNow : state.item) }
  }),
  runTransaction: vi.fn(async (db, fn) => {
    const tx = {
      get: async () => {
        if (state.readsRefused) throw Object.assign(new Error('denied'), { code: 'permission-denied' })
        return { exists: () => true, data: () => state.item }
      },
      update() {},
      set() {},
    }
    const result = await fn(tx)
    if (state.commits++ < state.denials) throw Object.assign(new Error('denied'), { code: 'permission-denied' })
    return result
  }),
}))

const { placeBid } = await import('../../src/lib/bids.js')

const ts = (ms) => ({ toMillis: () => ms })
const SETTINGS = { biddingOpen: true, minIncrement: 50, maxIncrement: null, antiSnipeSeconds: 120 }
const bid = () => placeBid({}, { itemId: 'item-001', uid: 'alice', amount: 5000, settings: SETTINGS })

beforeEach(() => {
  Object.assign(state, {
    denials: 0,
    commits: 0,
    readsRefused: false,
    settingsNow: SETTINGS,
    item: { currency: 'Rs.', currentAmount: 5000, bidCount: 0, endTime: ts(Date.now() + 3_600_000), lastBidAt: null },
  })
})

describe('placeBid: emergency stop', () => {
  it('when even reads are refused, the bidder is told the auction is unavailable', async () => {
    state.denials = 5
    state.readsRefused = true
    await expect(bid()).rejects.toMatchObject({ code: 'unavailable', message: 'The auction is temporarily unavailable. Please try again later.' })
    expect(state.commits).toBe(0) // refused at the transaction's first read
  })

  it('reads refused only after the commit was refused: also unavailable', async () => {
    state.denials = 5
    const { getDocFromServer } = await import('firebase/firestore')
    getDocFromServer.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'permission-denied' }))
    await expect(bid()).rejects.toMatchObject({ code: 'unavailable' })
    expect(state.commits).toBe(1)
  })

  it('other read errors are passed on unchanged', async () => {
    state.denials = 5
    const { getDocFromServer } = await import('firebase/firestore')
    getDocFromServer.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'unavailable' }))
    await expect(bid()).rejects.toMatchObject({ code: 'unavailable', message: 'offline' })
  })
})

describe('placeBid: refusals on an unchanged item', () => {
  it('a pause that is over again by the second refusal is retried and the bid goes through', async () => {
    state.denials = 2
    await expect(bid()).resolves.toEqual({ bidCount: 1, amount: 5000 })
    expect(state.commits).toBe(3)
  })

  it('gives up after three attempts with the original error', async () => {
    state.denials = 3
    await expect(bid()).rejects.toMatchObject({ code: 'permission-denied' })
    expect(state.commits).toBe(3)
  })

  it('bidding still off: "closed", without a third attempt', async () => {
    state.denials = 5
    state.settingsNow = { ...SETTINGS, biddingOpen: false }
    await expect(bid()).rejects.toMatchObject({ code: 'closed', message: 'Bidding is currently closed.' })
    expect(state.commits).toBe(2)
  })

  describe('refused before the start time', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('a start clearly ahead (the page had not heard of it): "hasn\'t started", at once', async () => {
      state.denials = 5
      state.settingsNow = { ...SETTINGS, startTime: ts(Date.now() + 60_000) }
      const p = bid()
      const caught = p.catch((e) => e)
      await vi.advanceTimersByTimeAsync(1_000) // only the usual short pause between the two attempts
      expect(await caught).toMatchObject({ code: 'not-started', message: expect.stringMatching(/^Bidding hasn't started yet\. It opens at .+\.$/) })
      expect(state.commits).toBe(2)
    })

    it('right at the start (this device runs a little ahead): waits it out and the retry goes through', async () => {
      state.denials = 2
      state.settingsNow = { ...SETTINGS, startTime: ts(Date.now() + 500) }
      const p = bid()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(state.commits).toBe(2) // waiting until 2 s after the start
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(p).resolves.toMatchObject({ bidCount: 1 })
      expect(state.commits).toBe(3)
    })

    it('still refused after waiting (this device is more than 2 s fast): "just opening", not the generic refusal', async () => {
      state.denials = 5
      state.settingsNow = { ...SETTINGS, startTime: ts(Date.now() + 500) }
      const caught = bid().catch((e) => e)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await caught).toMatchObject({ code: 'opening', message: 'Bidding is just opening. Please try again in a moment.' })
      expect(state.commits).toBe(3)
    })

    it('refused well after the start: the start is not the reason, so the refusal stands', async () => {
      Object.assign(state, { denials: 5, settingsNow: { ...SETTINGS, startTime: ts(Date.now() - 15_000) } })
      const caught = bid().catch((e) => e)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await caught).toMatchObject({ code: 'permission-denied' })
    })

    it('a start time that is not a timestamp on the server: "closed" (the rules refuse every bid)', async () => {
      Object.assign(state, { denials: 5, settingsNow: { ...SETTINGS, startTime: '2020-01-01T00:00:00Z' } })
      const caught = bid().catch((e) => e)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await caught).toMatchObject({ code: 'closed', message: 'Bidding is currently closed.' })
      expect(state.commits).toBe(2)
    })

    it('a start long past does not explain a refusal: retried as before', async () => {
      Object.assign(state, { denials: 2, settingsNow: { ...SETTINGS, startTime: ts(Date.now() - 60_000) } })
      const p = bid()
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(p).resolves.toMatchObject({ bidCount: 1 })
    })
  })

  it('within 2 s of the end: "just closed"', async () => {
    state.denials = 5
    state.item.endTime = ts(Date.now() + 1_000)
    await expect(bid()).rejects.toMatchObject({ code: 'ended', message: 'Bidding on this item has just closed.' })
    expect(state.commits).toBe(2)
  })
})
