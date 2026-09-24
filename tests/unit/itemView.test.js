import { describe, it, expect } from 'vitest'
import { itemView } from '../../src/lib/itemView.js'

const NOW = 1_000_000_000_000
const ts = (ms) => ({ toMillis: () => ms })
const settings = { biddingOpen: true, minIncrement: 50, maxIncrement: 1000, antiSnipeSeconds: 120 }
const item = (over = {}) => ({
  id: 'item-001', currentAmount: 5000, bidCount: 1, highBidderUid: 'bob',
  endTime: ts(NOW + 3_600_000), lastBidAt: null, ...over,
})
const view = (it, over = {}) =>
  itemView(it, { settings, uid: 'alice', myBidItemIds: new Set(), now: NOW, ...over })

describe('itemView', () => {
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
  it('cannot bid when bidding is closed', () => {
    expect(view(item(), { settings: { ...settings, biddingOpen: false } }).canBid).toBe(false)
  })
})
