import { describe, it, expect } from 'vitest'
import { planImport, toCsv, winnersCsv, bidsCsv, bidCountsCsv, planSchedule, currentSchedule, lotsText } from '../../src/lib/admin.js'

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

describe('closing schedule (setup)', () => {
  const NOW = END - 86_400_000
  const lots = [dbItem({ id: 'item-002', order: 2 }), dbItem({ id: 'item-000', order: 0 }), dbItem({ id: 'item-001', order: 1 })]

  it('closes the lots in lot order, a gap apart', () => {
    expect(planSchedule(lots, END, 60_000, settings, NOW)).toEqual({ ends: [
      { id: 'item-000', order: 0, end: END }, { id: 'item-001', order: 1, end: END + 60_000 }, { id: 'item-002', order: 2, end: END + 120_000 },
    ] })
    expect(planSchedule(lots, END, 0, settings, NOW).ends.map((e) => e.end)).toEqual([END, END, END]) // no gap: all at once
  })

  it('only before any bids', () => {
    expect(planSchedule([...lots, dbItem({ id: 'item-003', order: 3, bidCount: 2 })], END, 60_000, settings, NOW).error)
      .toBe('Only before any bids: 1 item(s) already have bids. Use the per-item controls, or reset all bids first.')
  })

  it('refuses no items, no or past first close, a bad gap, and closing before the start', () => {
    const err = (...a) => planSchedule(...a).error
    expect(err([], END, 0, settings, NOW)).toBe('There are no items yet.')
    expect(err(lots, NaN, 0, settings, NOW)).toBe('Choose when the first item closes.')
    expect(err(lots, END, null, settings, NOW)).toBe('The gap must look like 30s, 1m or 2h.') // parseDuration refused it
    expect(err(lots, END, -1, settings, NOW)).toBe('The gap must look like 30s, 1m or 2h.')
    expect(err(lots, NOW, 0, settings, NOW)).toBe('The first closing time is in the past.')
    expect(err(lots, END, 0, { ...settings, startTime: ts(END) }, NOW)).toBe('Items must close after bidding starts.')
    expect(planSchedule(lots, END, 0, { ...settings, startTime: ts(END - 1) }, NOW).ends).toHaveLength(3)
  })

  it('refuses a gap over 24 h and times Firestore cannot store (Invalid Date before)', () => {
    expect(planSchedule(lots, END, 86_400_000, settings, NOW).ends).toHaveLength(3)
    expect(planSchedule(lots, END, 86_400_001, settings, NOW).error).toBe('The gap can be at most 24h.')
    expect(planSchedule(lots, Date.UTC(9999, 11, 31, 23, 59), 60_000, settings, NOW).error).toBe('That is too far in the future.')
    expect(planSchedule(lots, Date.UTC(9999, 11, 31, 23, 50), 60_000, settings, NOW).ends).toHaveLength(3)
  })

  it('lotsText names lots in order, then "and N more"', () => {
    const at = (...orders) => orders.map((order) => ({ order }))
    expect(lotsText(at(3))).toBe('lot 3')
    expect(lotsText(at(5, 3))).toBe('lots 3 and 5')
    expect(lotsText(at(7, 3, 5))).toBe('lots 3, 5 and 7')
    expect(lotsText(at(9, 7, 3, 5, 11))).toBe('lots 3, 5, 7 and 2 more')
  })

  it('currentSchedule: the earliest close, and the gap when it is even', () => {
    const at = (order, end) => dbItem({ id: `item-00${order}`, order, endTime: ts(end) })
    expect(currentSchedule([at(1, END + 60_000), at(0, END), at(2, END + 120_000)])).toEqual({ firstEnd: END, staggerMs: 60_000 })
    expect(currentSchedule([at(0, END), at(1, END + 60_000), at(2, END + 60_000)])).toEqual({ firstEnd: END, staggerMs: null })
    expect(currentSchedule([at(0, END + 60_000), at(1, END)])).toEqual({ firstEnd: END, staggerMs: null }) // out of lot order
    expect(currentSchedule([at(0, END)])).toEqual({ firstEnd: END, staggerMs: 0 })
    expect(currentSchedule([])).toEqual({ firstEnd: null, staggerMs: null })
  })
})

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

  it('neutralises formulas in text cells but keeps numbers numeric', () => {
    const row = ['=HYPERLINK("http://x")', '+1', '-2', '@SUM(A1)', '\tx', 'Ann', -5, 7000]
    expect(toCsv(['h'], [row]).split('\r\n')[1])
      .toBe(`"'=HYPERLINK(""http://x"")",'+1,'-2,'@SUM(A1),'\tx,Ann,-5,7000`)
  })

  it('bidder names from the database are neutralised in exports', () => {
    const items = [{ id: 'item-000', order: 0, title: 'T', subtitle: '', bidCount: 1, currentAmount: 100, currency: 'Rs.', highBidderUid: 'u1', endTime: 0 }]
    const users = new Map([['u1', { name: '=cmd|"/c calc"!A1', email: 'e@x.test' }]])
    const csv = winnersCsv(items, { antiSnipeSeconds: 0 }, users, 1)
    expect(csv).toContain(`"'=cmd|""/c calc""!A1"`)
    expect(csv).not.toMatch(/,=cmd/)
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

  describe('bidCountsCsv', () => {
    const items = [
      dbItem({ order: 2, id: 'item-002', title: 'Lamp' }),
      dbItem({ order: 1, id: 'item-001', title: 'Desk' }),
      dbItem({ order: 3, id: 'item-003', title: 'No bids here' }),
    ]
    const bid = (itemId, uid) => ({ itemId, uid, n: 1, amount: 1, createdAt: ts(0) })

    it('counts bids per bidder per lot, with a total per bidder and a totals row', () => {
      const bids = [bid('item-001', 'u1'), bid('item-001', 'u1'), bid('item-002', 'u1'), bid('item-002', 'u2'), bid('item-001', 'u3')]
      const users = new Map([['u1', { name: 'bob', email: 'b@x' }], ['u2', { name: 'Ann', email: 'a@x' }]])
      expect(bidCountsCsv(bids, items, users).split('\r\n')).toEqual([
        '﻿Bidder,Bidder email,Total bids,Lot 1: Desk,Lot 2: Lamp,Lot 3: No bids here',
        'Ann,a@x,1,0,1,0', // names sorted ignoring case
        'bob,b@x,3,2,1,0',
        'u3,,1,1,0,0', // no profile: the uid stands in
        'Total,,5,3,2,0',
      ])
    })

    it('bidders with the same name are told apart by email; a deleted item keeps its column', () => {
      const bids = [bid('item-009', 'u1'), bid('item-001', 'u2')]
      const users = new Map([['u1', { name: 'Sam', email: 'z@x' }], ['u2', { name: 'sam', email: 'a@x' }]])
      const rows = bidCountsCsv(bids, items, users).split('\r\n')
      expect(rows[0]).toMatch(/,Lot 3: No bids here,item-009$/)
      expect(rows.slice(1)).toEqual(['sam,a@x,1,1,0,0,0', 'Sam,z@x,1,0,0,0,1', 'Total,,2,1,0,0,1'])
    })

    it('no bids: only the header and a zero totals row; names are neutralised', () => {
      expect(bidCountsCsv([], items, new Map()).split('\r\n').slice(1)).toEqual(['Total,,0,0,0,0'])
      const csv = bidCountsCsv([bid('item-001', 'u1')], items, new Map([['u1', { name: '=1+1', email: 'e@x' }]]))
      expect(csv.split('\r\n')[1]).toBe("'=1+1,e@x,1,1,0,0")
    })
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
