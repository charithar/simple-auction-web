import { describe, it, expect } from 'vitest'
import { parseAuctionFile, parseDuration } from '../../src/lib/importItems.js'

// Validation paths of the auction file not covered by importItems.test.js.
const errorsOf = (text) => parseAuctionFile(text).errors

describe('parseAuctionFile: auction section', () => {
  it('a file without an auction section still reports the missing increment', () => {
    expect(errorsOf('items:\n  - { id: 1, title: A, startingPrice: 100, endTime: 2030-01-01T00:00:00Z }'))
      .toEqual(['auction: minIncrement must be a positive whole number'])
  })

  it('checks maxIncrement, antiSnipeSeconds and endTime', () => {
    expect(errorsOf(`
auction: { minIncrement: 50, maxIncrement: 0, antiSnipeSeconds: -5, endTime: "next friday" }
items: [{ id: 1, title: A, startingPrice: 100 }]`)).toEqual([
      'auction: maxIncrement must be a positive whole number',
      'auction: antiSnipeSeconds must be a whole number ≥ 0',
      'auction: endTime must be an ISO 8601 date',
      'items[0] (id 1): maxIncrement is smaller than minIncrement', // the item inherits the bad maximum
      'items[0] (id 1): no endTime (set auction.endTime or the item endTime)',
    ])
    expect(errorsOf(`
auction: { minIncrement: 50, antiSnipeSeconds: 1.5, endTime: 2030-01-01T00:00:00Z }
items: [{ id: 1, title: A, startingPrice: 100 }]`)).toEqual(['auction: antiSnipeSeconds must be a whole number ≥ 0'])
  })

  it('an invalid stagger is reported once, not again for every item', () => {
    expect(errorsOf(`
auction: { minIncrement: 50, endTime: 2030-01-01T00:00:00Z, stagger: soon }
items: [{ id: 1, title: A, startingPrice: 100 }, { id: 2, title: B, startingPrice: 100 }]`))
      .toEqual(['auction: stagger must look like 30s, 1m, 2h or a number of seconds'])
  })

  it('needs a non-empty item list', () => {
    expect(errorsOf('auction: { minIncrement: 50 }\nitems: []')).toEqual(['items: expected a non-empty list'])
    expect(errorsOf('auction: { minIncrement: 50 }\nitems: { a: 1 }')).toEqual(['items: expected a non-empty list'])
  })

  it('an unquoted YAML timestamp is accepted', () => {
    const { items, errors } = parseAuctionFile(`
auction: { minIncrement: 50, endTime: 2030-06-01T18:00:00+05:30 }
items: [{ id: 1, title: A, startingPrice: 100 }]`)
    expect(errors).toEqual([])
    expect(items[0].endTime.toISOString()).toBe('2030-06-01T12:30:00.000Z')
  })
})

describe('parseAuctionFile: items', () => {
  const file = (items) => `auction: { minIncrement: 50, endTime: 2030-01-01T00:00:00Z }\nitems:\n${items}`

  it('entries that are not objects are reported by position', () => {
    expect(errorsOf(file('  - null\n  - [1, 2]\n  - just text'))).toEqual([
      'items[0]: not an object', 'items[1]: not an object', 'items[2]: not an object',
    ])
  })

  it('a missing or negative id', () => {
    expect(errorsOf(file('  - { title: A, startingPrice: 100 }\n  - { id: -1, title: B, startingPrice: 100 }'))).toEqual([
      'items[0]: id must be a whole number ≥ 0',
      'items[1] (id -1): id must be a whole number ≥ 0',
    ])
  })

  it('per-item increments, endTime and images are validated', () => {
    expect(errorsOf(file('  - { id: 1, title: A, startingPrice: 100, minIncrement: 2.5, maxIncrement: -1, endTime: soon, images: https://x/a.png }'))).toEqual([
      'items[0] (id 1): minIncrement must be a positive whole number',
      'items[0] (id 1): maxIncrement must be a positive whole number',
      'items[0] (id 1): endTime must be an ISO 8601 date',
      'items[0] (id 1): images must be a list of URLs',
    ])
  })
})

describe('parseDuration', () => {
  it.each([
    [90, 90_000], ['90', 90_000], ['30s', 30_000], ['5m', 300_000], ['2h', 7_200_000], [' 3 M ', 180_000], [0, 0],
  ])('%j → %i ms', (v, ms) => expect(parseDuration(v)).toBe(ms))

  it.each([-1, Infinity, NaN, '1.5m', 'soon', '5d', ''])('%j is invalid', (v) => expect(parseDuration(v)).toBeNull())
})
