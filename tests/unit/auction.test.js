import { describe, it, expect } from 'vitest'
import {
  effectiveEnd, minNextBid, maxNextBid, validateBid, formatRemaining,
} from '../../src/lib/auction.js'

const settings = { biddingOpen: true, minIncrement: 50, maxIncrement: 1000, antiSnipeSeconds: 120 }
const NOW = 1_000_000_000_000
const item = (over = {}) => ({
  currency: 'Rs.', currentAmount: 5000, bidCount: 0, endTime: NOW + 60_000, lastBidAt: null, ...over,
})

describe('effectiveEnd / anti-sniping', () => {
  it('is endTime when there are no bids', () => {
    expect(effectiveEnd(item(), settings)).toBe(NOW + 60_000)
  })
  it('ignores early bids', () => {
    expect(effectiveEnd(item({ lastBidAt: NOW - 3_600_000 }), settings)).toBe(NOW + 60_000)
  })
  it('extends to lastBidAt + window for late bids', () => {
    expect(effectiveEnd(item({ lastBidAt: NOW }), settings)).toBe(NOW + 120_000)
  })
  it('accepts Firestore-like timestamps', () => {
    const ts = (ms) => ({ toMillis: () => ms })
    expect(effectiveEnd(item({ endTime: ts(NOW), lastBidAt: ts(NOW) }), settings)).toBe(NOW + 120_000)
  })
})

describe('increments', () => {
  it('first bid may equal the starting price', () => {
    expect(minNextBid(item(), settings)).toBe(5000)
  })
  it('later bids need the global min increment', () => {
    expect(minNextBid(item({ bidCount: 1 }), settings)).toBe(5050)
  })
  it('per-item overrides win', () => {
    const it2 = item({ bidCount: 1, minIncrement: 500, maxIncrement: 2000 })
    expect(minNextBid(it2, settings)).toBe(5500)
    expect(maxNextBid(it2, settings)).toBe(7000)
  })
  it('no max when neither item nor settings set one', () => {
    expect(maxNextBid(item(), { ...settings, maxIncrement: null })).toBeNull()
  })
})

describe('validateBid', () => {
  const v = (it2, amount, s = settings) => validateBid(it2, s, amount, NOW).code ?? 'ok'
  it('accepts a valid bid', () => expect(v(item(), 5000)).toBe('ok'))
  it('rejects too low', () => expect(v(item({ bidCount: 1 }), 5049)).toBe('too-low'))
  it('rejects too high', () => expect(v(item(), 6001)).toBe('too-high'))
  it('rejects non-integers', () => expect(v(item(), 5000.5)).toBe('invalid'))
  it('rejects ended items', () => expect(v(item({ endTime: NOW - 1 }), 5000)).toBe('ended'))
  it('accepts within anti-snipe window', () =>
    expect(v(item({ endTime: NOW - 1, lastBidAt: NOW - 30_000 }), 5000)).toBe('ok'))
  it('rejects when bidding closed', () =>
    expect(v(item(), 5000, { ...settings, biddingOpen: false })).toBe('closed'))
})

describe('formatRemaining', () => {
  it('formats', () => {
    expect(formatRemaining(0)).toBe('Ended')
    expect(formatRemaining(45_000)).toBe('45s')
    expect(formatRemaining(125_000)).toBe('2m 5s')
    expect(formatRemaining(3_723_000)).toBe('1h 2m')
    expect(formatRemaining(90_000_000)).toBe('1d 1h')
  })
})
