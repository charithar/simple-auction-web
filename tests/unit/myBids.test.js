import { describe, it, expect } from 'vitest'
import { myBidsSummary, formatTotal, standings, newlyOutbid } from '../../src/lib/myBids.js'

const item = (id, currentAmount, currency = 'Rs.', highBidderUid = 'rival') => ({ id, title: `Lot ${id}`, currentAmount, currency, highBidderUid })
const row = (it, standing) => ({ item: it, view: { standing } })

describe('myBidsSummary', () => {
  it('groups items by standing and ignores items without a bid', () => {
    const a = item('a', 100)
    const b = item('b', 200)
    const c = item('c', 300)
    const s = myBidsSummary([row(a, 'winning'), row(b, 'outbid'), row(c, null), row(item('d', 1), 'won')])
    expect(s.winning).toEqual([a])
    expect(s.outbid).toEqual([b])
    expect(s.won.map((i) => i.id)).toEqual(['d'])
    expect(s.lost).toEqual([])
  })
})

describe('formatTotal', () => {
  it('sums per currency', () => {
    expect(formatTotal([item('a', 12_000), item('b', 30_500)])).toBe('Rs. 42,500')
    expect(formatTotal([item('a', 100), item('b', 50, 'USD'), item('c', 25)])).toBe('Rs. 125 + USD 50')
  })
})

describe('newlyOutbid', () => {
  it('reports items that went from winning to outbid', () => {
    const a = item('a', 100)
    const b = item('b', 200)
    const before = standings([row(a, 'winning'), row(b, 'outbid')])
    expect(newlyOutbid(before, [row(a, 'outbid'), row(b, 'outbid')])).toEqual([a])
  })

  it('stays quiet when nobody leads (right after an admin reset)', () => {
    const a = item('a', 100)
    expect(newlyOutbid(standings([row(a, 'winning')]), [row({ ...a, highBidderUid: null }, 'outbid')])).toEqual([])
  })

  it('stays quiet on first load, for items already outbid, and when ended', () => {
    const a = item('a', 100)
    expect(newlyOutbid(new Map(), [row(a, 'outbid')])).toEqual([])
    expect(newlyOutbid(standings([row(a, 'winning')]), [row(a, 'lost')])).toEqual([])
    expect(newlyOutbid(standings([row(a, 'winning')]), [row(a, 'winning')])).toEqual([])
  })
})
