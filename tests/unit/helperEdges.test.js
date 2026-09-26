import { describe, it, expect } from 'vitest'
import { toMillis, formatMoney } from '../../src/lib/auction.js'
import { emailDomain, emailAllowed } from '../../src/lib/access.js'
import { toCsv, bidsCsv } from '../../src/lib/admin.js'

describe('toMillis', () => {
  it('accepts numbers, Dates and Timestamps; anything else is null', () => {
    expect(toMillis(5)).toBe(5)
    expect(toMillis(new Date(7))).toBe(7)
    expect(toMillis({ toMillis: () => 9 })).toBe(9)
    expect(toMillis(null)).toBeNull()
    expect(toMillis('2030-01-01')).toBeNull()
    expect(toMillis({ seconds: 1 })).toBeNull()
  })
})

describe('formatMoney', () => {
  it('groups thousands and tolerates a missing currency', () => {
    expect(formatMoney('Rs.', 1234567)).toBe('Rs. 1,234,567')
    expect(formatMoney(null, 1500)).toBe('1,500')
  })
})

describe('emailDomain / emailAllowed', () => {
  it('handles missing and mixed-case addresses', () => {
    expect(emailDomain(null)).toBe('')
    expect(emailDomain('Ann@Allowed.TEST')).toBe('allowed.test')
    expect(emailAllowed('Ann@Allowed.TEST', { domains: ['allowed.test'] })).toBe(true)
    expect(emailAllowed(null, { domains: ['allowed.test'] })).toBe(false)
    expect(emailAllowed('no-at-sign', { domains: ['allowed.test'] })).toBe(false)
  })
})

describe('CSV edge cases', () => {
  it('empty cells for null and undefined', () => {
    expect(toCsv(['a', 'b', 'c'], [[null, undefined, 0]]).split('\r\n')[1]).toBe(',,0')
  })

  it('bidsCsv: a bid on a deleted item and an unknown bidder keep their ids; no time stays empty', () => {
    const bids = [
      { itemId: 'item-009', n: 1, amount: 100, uid: 'ghost', createdAt: null },
      { itemId: 'item-001', n: 1, amount: 50, uid: 'u1', createdAt: { toMillis: () => Date.UTC(2030, 0, 1) } },
    ]
    const itemsById = new Map([['item-001', { order: 1, title: 'One' }]])
    const users = new Map([['u1', { name: 'Ann', email: 'ann@x' }]])
    const rows = bidsCsv(bids, itemsById, users).split('\r\n').slice(1)
    expect(rows).toEqual([
      ',item-009,1,100,ghost,,', // deleted item: no lot, id as title, uid as bidder, no time
      '1,One,1,50,Ann,ann@x,2030-01-01T00:00:00.000Z',
    ])
  })

  it('bidsCsv: bids on deleted items sort first, then by bid number', () => {
    const bids = [
      { itemId: 'gone-b', n: 2, amount: 2, uid: 'x' },
      { itemId: 'item-001', n: 1, amount: 3, uid: 'x' },
      { itemId: 'gone-a', n: 1, amount: 1, uid: 'x' },
    ]
    const rows = bidsCsv(bids, new Map([['item-001', { order: 1, title: 'One' }]]), new Map()).split('\r\n').slice(1)
    expect(rows.map((r) => r.split(',')[3])).toEqual(['1', '2', '3'])
  })
})
