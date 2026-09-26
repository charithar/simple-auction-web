import { describe, it, expect, vi, beforeEach } from 'vitest'

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

  it('within 2 s of the end: "just closed"', async () => {
    state.denials = 5
    state.item.endTime = ts(Date.now() + 1_000)
    await expect(bid()).rejects.toMatchObject({ code: 'ended', message: 'Bidding on this item has just closed.' })
    expect(state.commits).toBe(2)
  })
})
