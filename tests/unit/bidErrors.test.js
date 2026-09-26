import { describe, it, expect, vi, beforeEach } from 'vitest'

// bidErrorMessage for every error placeBid can surface, and the placeBid paths
// that need a scripted Firestore: a missing item, and a missing settings doc on
// the double-refusal path.
const state = { item: null, settingsNow: null, denials: 0, commits: 0 }
vi.mock('firebase/firestore', () => ({
  doc: (db, ...path) => ({ path: path.join('/') }),
  serverTimestamp: () => 'server-time',
  getDocFromServer: vi.fn(async (ref) => ({ data: () => (ref.path === 'settings/auction' ? state.settingsNow : state.item) })),
  runTransaction: vi.fn(async (db, fn) => {
    const tx = { get: async () => ({ exists: () => state.item != null, data: () => state.item }), update() {}, set() {} }
    const result = await fn(tx)
    if (state.commits++ < state.denials) throw Object.assign(new Error('denied'), { code: 'permission-denied' })
    return result
  }),
}))

const { placeBid, bidErrorMessage, BidError, outbidNotice } = await import('../../src/lib/bids.js')

const ts = (ms) => ({ toMillis: () => ms })
const SETTINGS = { biddingOpen: true, minIncrement: 50, maxIncrement: null, antiSnipeSeconds: 120 }

beforeEach(() => Object.assign(state, { item: null, settingsNow: null, denials: 0, commits: 0 }))

describe('bidErrorMessage', () => {
  it('passes BidError messages through', () => {
    expect(bidErrorMessage(new BidError('too-low', 'Minimum bid is Rs. 5,050.'))).toBe('Minimum bid is Rs. 5,050.')
  })

  it.each([
    ['permission-denied', /^Your bid was not accepted\. Someone may have outbid you or the item just closed/],
    ['aborted', /^Lots of bids are coming in right now/],
    ['failed-precondition', /^Lots of bids are coming in right now/],
    ['unavailable', /^You appear to be offline/],
    ['resource-exhausted', /^The auction is temporarily over capacity/],
    ['internal', /^Something went wrong placing your bid/],
  ])('Firestore %s → a message for bidders', (code, message) => {
    expect(bidErrorMessage({ code })).toMatch(message)
  })

  it('anything without a code gets the generic message', () => {
    expect(bidErrorMessage(undefined)).toMatch(/^Something went wrong/)
    expect(bidErrorMessage(new Error('boom'))).toMatch(/^Something went wrong/)
  })
})

describe('placeBid edge paths', () => {
  it('a bid on an item that no longer exists: "Item not found."', async () => {
    const bid = placeBid({}, { itemId: 'item-404', uid: 'alice', amount: 5000, settings: SETTINGS })
    await expect(bid).rejects.toMatchObject({ code: 'not-found', message: 'Item not found.' })
  })

  it('without a settings doc on the server, the closing check falls back to the bidder\'s settings', async () => {
    state.item = { currency: 'Rs.', currentAmount: 5000, bidCount: 0, endTime: ts(Date.now() + 1_000), lastBidAt: null }
    state.denials = 5
    state.settingsNow = undefined
    const bid = placeBid({}, { itemId: 'item-001', uid: 'alice', amount: 5000, settings: SETTINGS })
    await expect(bid).rejects.toMatchObject({ code: 'ended', message: 'Bidding on this item has just closed.' })
  })
})

describe('outbidNotice', () => {
  it('tells the bidder they were outbid, with the current price and minimum', () => {
    const settings = { minIncrement: 50 }
    expect(outbidNotice({ currency: 'Rs.', currentAmount: 7_250, bidCount: 3 }, settings))
      .toBe("You've been outbid. The price is now Rs. 7,250; the minimum bid is Rs. 7,300.")
    expect(outbidNotice({ currency: 'Rs.', currentAmount: 7_250, bidCount: 3, minIncrement: 250 }, settings))
      .toBe("You've been outbid. The price is now Rs. 7,250; the minimum bid is Rs. 7,500.")
  })
})
