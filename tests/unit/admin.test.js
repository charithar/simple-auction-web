import { describe, it, expect } from 'vitest'
import { planImport, toCsv, winnersCsv, bidsCsv } from '../../src/lib/admin.js'

const ts = (ms) => ({ toMillis: () => ms })
const END = Date.UTC(2030, 5, 1, 12)
const fileItem = (over = {}) => ({
  id: 'item-001', order: 1, title: 'A', subtitle: '', category: '', condition: '', specs: [],
  detail: '', images: [], currency: 'Rs.', startingPrice: 100, endTime: new Date(END), ...over,
})
const dbItem = (over = {}) => ({
  ...fileItem(), endTime: ts(END), currentAmount: 100, bidCount: 0, highBidderUid: null, lastBidAt: null, ...over,
})
const settings = { title: 'T', minIncrement: 50, maxIncrement: null, antiSnipeSeconds: 120 }

describe('planImport', () => {
  it('classifies creates, updates, unchanged and missing', () => {
    const plan = planImport(
      { settings, items: [fileItem(), fileItem({ id: 'item-002', order: 2 }), fileItem({ id: 'item-003', order: 3, title: 'New' })] },
      [dbItem(), dbItem({ id: 'item-003', order: 3 }), dbItem({ id: 'item-009', order: 9, title: 'Gone', bidCount: 2 })],
    )
    expect(plan.unchanged).toEqual(['item-001'])
    expect(plan.creates.map((i) => i.id)).toEqual(['item-002'])
    expect(plan.updates).toEqual([expect.objectContaining({ changes: ['title'], hasBids: false, warnings: [] })])
    expect(plan.missing).toEqual([{ id: 'item-009', title: 'Gone', hasBids: true }])
  })

  it('warns when bid terms change on items that have bids', () => {
    const plan = planImport(
      { settings, items: [fileItem({ startingPrice: 200, endTime: new Date(END + 60_000), title: 'B' })] },
      [dbItem({ bidCount: 3 })],
    )
    expect(plan.updates[0].changes).toEqual(['title', 'startingPrice', 'endTime'])
    expect(plan.updates[0].warnings).toEqual(['startingPrice', 'endTime'])
  })

  it('detects a removed per-item increment override', () => {
    const plan = planImport({ settings, items: [fileItem()] }, [dbItem({ minIncrement: 10 })])
    expect(plan.updates[0].changes).toEqual(['minIncrement'])
  })

  it('compares specs and images by value', () => {
    const specs = [{ name: 'CPU', value: 'i5' }]
    const plan = planImport(
      { settings, items: [fileItem({ specs, images: ['a'] })] },
      [dbItem({ specs: [{ name: 'CPU', value: 'i5' }], images: ['a'] })],
    )
    expect(plan.unchanged).toEqual(['item-001'])
  })
})

describe('CSV', () => {
  it('escapes quotes, commas and newlines and adds a BOM', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'say "hi"\nnow']])).toBe('﻿a,b\r\n"x,y","say ""hi""\nnow"')
  })

  it('winnersCsv marks sold / open / no bids', () => {
    const now = END + 10 * 60_000
    const items = [
      dbItem({ order: 2, id: 'item-002', title: 'Sold one', bidCount: 2, currentAmount: 150, highBidderUid: 'u1' }),
      dbItem({ order: 1, title: 'Unsold' }),
      dbItem({ order: 3, id: 'item-003', title: 'Still open', bidCount: 1, highBidderUid: 'u2', endTime: ts(now + 60_000) }),
    ]
    const users = new Map([['u1', { name: 'Ann', email: 'ann@x.com' }]])
    const rows = winnersCsv(items, { antiSnipeSeconds: 120 }, users, now).split('\r\n').slice(1)
    expect(rows[0]).toMatch(/^1,Unsold,,No bids,,Rs\.,0,,,/)
    expect(rows[1]).toMatch(/^2,Sold one,,Sold,150,Rs\.,2,Ann,ann@x.com,/)
    expect(rows[2]).toMatch(/^3,Still open,,Open,100,Rs\.,1,u2,,/)
  })

  it('bidsCsv orders by lot then bid number', () => {
    const itemsById = new Map([['item-001', { order: 1, title: 'A' }], ['item-002', { order: 2, title: 'B' }]])
    const csv = bidsCsv(
      [
        { itemId: 'item-002', n: 1, amount: 5, uid: 'u1', createdAt: ts(0) },
        { itemId: 'item-001', n: 2, amount: 9, uid: 'u1', createdAt: ts(0) },
        { itemId: 'item-001', n: 1, amount: 7, uid: 'u2', createdAt: ts(0) },
      ],
      itemsById,
      new Map([['u1', { name: 'Ann', email: 'a@x' }]]),
    )
    expect(csv.split('\r\n').slice(1).map((r) => r.split(',').slice(0, 5).join(','))).toEqual([
      '1,A,1,7,u2', '1,A,2,9,Ann', '2,B,1,5,Ann',
    ])
  })
})
