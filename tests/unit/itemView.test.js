import { describe, it, expect } from 'vitest'
import { viewFor, initialBidText, matchesFilter } from '../../src/lib/itemView.js'

const NOW = 1_000_000_000_000
const ts = (ms) => ({ toMillis: () => ms })
const settings = { biddingOpen: true, minIncrement: 50, maxIncrement: 1000, antiSnipeSeconds: 120 }
const item = (over = {}) => ({
  id: 'item-001', currentAmount: 5000, bidCount: 1, highBidderUid: 'bob',
  endTime: ts(NOW + 3_600_000), lastBidAt: null, ...over,
})
const view = (it, over = {}) =>
  viewFor(it, { settings, uid: 'alice', myBidItemIds: new Set(), now: NOW, ...over })

describe('viewFor', () => {
  it('no standing when the user never bid', () => {
    expect(view(item())).toMatchObject({ standing: null, status: 'open', canBid: true, minBid: 5050, maxBid: 6000 })
  })
  it('winning / outbid while open', () => {
    expect(view(item({ highBidderUid: 'alice' })).standing).toBe('winning')
    expect(view(item(), { myBidItemIds: new Set(['item-001']) }).standing).toBe('outbid')
  })
  it('won / lost once ended', () => {
    const ended = { endTime: ts(NOW - 1) }
    expect(view(item({ ...ended, highBidderUid: 'alice' })).standing).toBe('won')
    expect(view(item(ended), { myBidItemIds: new Set(['item-001']) })).toMatchObject({ standing: 'lost', canBid: false })
  })
  it('closing under 5 minutes', () => {
    expect(view(item({ endTime: ts(NOW + 60_000) })).status).toBe('closing')
  })
  it('flags anti-snipe extensions', () => {
    const v = view(item({ endTime: ts(NOW - 1000), lastBidAt: ts(NOW - 30_000) }))
    expect(v).toMatchObject({ extended: true, ended: false, remaining: 90_000 })
  })
  it('flags the final two minutes', () => {
    expect(view(item({ endTime: ts(NOW + 119_000) })).final).toBe(true)
    expect(view(item({ endTime: ts(NOW + 121_000) })).final).toBe(false)
    expect(view(item({ endTime: ts(NOW - 1_000) })).final).toBe(false) // ended
  })
  it('cannot bid when bidding is closed', () => {
    expect(view(item(), { settings: { ...settings, biddingOpen: false } }).canBid).toBe(false)
  })
})

describe('initialBidText', () => {
  it('is the minimum bid', () => {
    expect(initialBidText(view(item()))).toBe('5050')
  })
  it('is empty (not "null") without a view', () => {
    expect(initialBidText(null)).toBe('')
  })
})

describe('matchesFilter', () => {
  const ctx = { settings, uid: 'alice', myBidItemIds: new Set(), now: NOW }

  it('"Open" keeps an item anti-snipe extended past its scheduled end', () => {
    // Scheduled end 30 s ago, last bid 10 s ago: anti-snipe keeps it open for 110 s.
    const extended = item({ endTime: ts(NOW - 30_000), lastBidAt: ts(NOW - 10_000) })
    expect(matchesFilter('open', viewFor(extended, ctx))).toBe(true)
  })

  it('"Open" drops ended items', () => {
    const ended = item({ endTime: ts(NOW - 300_000), lastBidAt: ts(NOW - 200_000) })
    expect(matchesFilter('open', viewFor(ended, ctx))).toBe(false)
  })

  it('"My bids" and "Outbid" follow the standing; "All" keeps everything', () => {
    const outbid = viewFor(item(), { ...ctx, myBidItemIds: new Set(['item-001']) })
    expect(matchesFilter('mine', outbid)).toBe(true)
    expect(matchesFilter('outbid', outbid)).toBe(true)
    const none = viewFor(item(), ctx)
    expect(matchesFilter('mine', none)).toBe(false)
    expect(matchesFilter('all', none)).toBe(true)
  })
})
