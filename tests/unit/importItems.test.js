import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  parseAuctionFile, shiftEndTimes, newItemDoc, itemDocId, parseDuration,
} from '../../src/lib/importItems.js'

const file = (items, auction = '') => `
auction:
  title: Test
  currency: Rs.
  minIncrement: 50
  maxIncrement: 1000
  endTime: 2030-06-01T18:00:00+05:30
  stagger: 1m
${auction}
items:
${items}
`

const ok = `
  - id: 3
    title: HP ProDesk 400 G4
    subtitle: S/N ABC
    category: Desktop
    condition: Used
    specs: { CPU: Core i5, RAM: 16 GB }
    detail: text
    images: [https://x/a.png, https://x/a.png, https://x/b.png]
    startingPrice: 6000
  - id: 4
    title: Second
    startingPrice: 100
    minIncrement: 10
    currency: USD
`

describe('parseAuctionFile', () => {
  it('parses settings and items', () => {
    const { settings, items, errors } = parseAuctionFile(file(ok))
    expect(errors).toEqual([])
    expect(settings).toEqual({ title: 'Test', minIncrement: 50, maxIncrement: 1000, antiSnipeSeconds: 120 })
    expect(items[0]).toMatchObject({
      id: 'item-003', order: 3, title: 'HP ProDesk 400 G4', subtitle: 'S/N ABC',
      category: 'Desktop', condition: 'Used', currency: 'Rs.', startingPrice: 6000,
      specs: [{ name: 'CPU', value: 'Core i5' }, { name: 'RAM', value: '16 GB' }],
      images: ['https://x/a.png', 'https://x/b.png'],
    })
    expect(items[1]).toMatchObject({ currency: 'USD', minIncrement: 10, specs: [], images: [] })
  })

  it('staggers end times in list order from auction.endTime', () => {
    const { items } = parseAuctionFile(file(ok))
    expect(items.map((i) => i.endTime.toISOString())).toEqual([
      '2030-06-01T12:30:00.000Z',
      '2030-06-01T12:31:00.000Z',
    ])
  })

  it('per-item endTime overrides the schedule', () => {
    const { items } = parseAuctionFile(file(`
  - id: 1
    title: A
    startingPrice: 100
    endTime: 2030-07-01T00:00:00Z`))
    expect(items[0].endTime.toISOString()).toBe('2030-07-01T00:00:00.000Z')
  })

  it('reports every problem with context', () => {
    const { items, errors } = parseAuctionFile(file(`
  - id: 1
    title: ""
    startingPrice: 10.5
    specs: [a]
  - id: 1
    title: B
    startingPrice: 100
    maxIncrement: 10`))
    expect(items).toEqual([])
    expect(errors).toEqual([
      'items[0] (id 1): title is required',
      'items[0] (id 1): startingPrice must be a positive whole number',
      'items[0] (id 1): specs must be a map of name: value',
      'items[1] (id 1): duplicate id',
      'items[1] (id 1): maxIncrement is smaller than minIncrement',
    ])
  })

  it('validates the auction section', () => {
    const { errors } = parseAuctionFile(`
auction: { minIncrement: 0, stagger: soon }
items: [{ id: 1, title: A, startingPrice: 1 }]`)
    expect(errors).toEqual([
      'auction: minIncrement must be a positive whole number',
      'auction: stagger must look like 30s, 1m, 2h or a number of seconds',
      'items[0] (id 1): no endTime (set auction.endTime or the item endTime)',
    ])
  })

  it('rejects wrong shapes and bad syntax', () => {
    expect(parseAuctionFile('- a').errors).toEqual(['Expected top-level "auction" and "items" sections.'])
    expect(parseAuctionFile('auction: {minIncrement: 1}\nitems: []').errors).toEqual(['items: expected a non-empty list'])
    expect(parseAuctionFile('a: [').errors[0]).toMatch(/not valid YAML/)
  })

  it('parses the real data/auction.yml', () => {
    const { items, errors } = parseAuctionFile(readFileSync('data/auction.yml', 'utf8'))
    expect(errors).toEqual([])
    expect(items.length).toBeGreaterThan(0)
  })
})

describe('parseDuration', () => {
  it.each([[90, 90_000], ['30s', 30_000], ['5m', 300_000], ['2h', 7_200_000], ['45', 45_000]])(
    '%s -> %i ms', (input, ms) => expect(parseDuration(input)).toBe(ms))
  it('rejects junk', () => expect(parseDuration('1 day')).toBeNull())
})

describe('shiftEndTimes', () => {
  it('moves the earliest to firstEnd and keeps gaps', () => {
    const out = shiftEndTimes([
      { endTime: new Date('2025-01-01T00:05:00Z') },
      { endTime: new Date('2025-01-01T00:04:00Z') },
    ], new Date('2030-06-01T12:00:00Z'))
    expect(out.map((i) => i.endTime.toISOString())).toEqual(['2030-06-01T12:01:00.000Z', '2030-06-01T12:00:00.000Z'])
  })
})

describe('newItemDoc', () => {
  it('starts with no bids at the starting price and drops the id', () => {
    const doc = newItemDoc({ id: itemDocId(7), order: 7, title: 'A', startingPrice: 100, endTime: new Date() })
    expect(doc).toMatchObject({ currentAmount: 100, bidCount: 0, highBidderUid: null, lastBidAt: null })
    expect(doc).not.toHaveProperty('id')
  })
})
