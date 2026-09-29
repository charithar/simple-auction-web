import { describe, it, expect } from 'vitest'
import {
  effectiveEnd, minNextBid, maxNextBid, validateBid, formatRemaining,
  startOf, notStartedYet, formatStart, toLocalInput, startInvalid, biddingClosed, closingBeforeStart,
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
  it('rejects before the start time, accepts from it (like the rules: request.time >= startTime)', () => {
    const at = (start) => ({ ...settings, startTime: { toMillis: () => start } })
    const early = validateBid(item(), at(NOW + 1), 5000, NOW)
    expect(early).toMatchObject({ ok: false, code: 'not-started' })
    expect(early.message).toMatch(/^Bidding hasn't started yet\. It opens at .+\.$/)
    expect(v(item(), 5000, at(NOW))).toBe('ok')
    expect(v(item(), 5000, { ...settings, startTime: null })).toBe('ok')
  })
  it('a pause wins over a start time still ahead', () =>
    expect(v(item(), 5000, { ...settings, biddingOpen: false, startTime: NOW + 1 })).toBe('closed'))
})

describe('start time', () => {
  const ts = (ms) => ({ toMillis: () => ms })
  it('startOf reads a Timestamp or a Date; nothing is null; anything else is invalid (NaN)', () => {
    expect(startOf({ startTime: ts(5) })).toBe(5)
    expect(startOf({ startTime: new Date(7) })).toBe(7)
    expect(startOf({})).toBe(null)
    expect(startOf({ startTime: null })).toBe(null)
    // Typed by hand in the console: the rules can't compare these with request.time.
    expect(startOf({ startTime: '2020-01-01T00:00:00Z' })).toBeNaN()
    expect(startOf({ startTime: NOW })).toBeNaN()
  })
  it('an invalid start closes bidding, like the rules; a valid or no start does not', () => {
    const open = { ...settings, biddingOpen: true }
    expect(startInvalid({ ...open, startTime: 'soon' })).toBe(true)
    expect(biddingClosed({ ...open, startTime: 'soon' })).toBe(true)
    expect(validateBid(item(), { ...open, startTime: NOW - 1 }, 5000, NOW).code).toBe('closed')
    expect(notStartedYet({ ...open, startTime: 'soon' }, NOW)).toBe(false) // no countdown to nowhere
    expect(biddingClosed({ ...open, startTime: ts(NOW - 1) })).toBe(false)
    expect(biddingClosed(open)).toBe(false)
    expect(biddingClosed({ ...open, biddingOpen: false })).toBe(true)
  })
  it('notStartedYet only while switched on and before the start', () => {
    expect(notStartedYet({ biddingOpen: true, startTime: ts(NOW + 1) }, NOW)).toBe(true)
    expect(notStartedYet({ biddingOpen: true, startTime: ts(NOW) }, NOW)).toBe(false)
    expect(notStartedYet({ biddingOpen: false, startTime: ts(NOW + 1) }, NOW)).toBe(false)
    expect(notStartedYet({ biddingOpen: true }, NOW)).toBe(false)
  })
  it('closingBeforeStart: items closing at or before the start; none without a valid start', () => {
    const items = [{ id: 'a', end: NOW - 1 }, { id: 'b', end: NOW }, { id: 'c', end: NOW + 1 }]
    const endOf = (it) => it.end
    expect(closingBeforeStart(items, NOW, endOf).map((it) => it.id)).toEqual(['a', 'b'])
    expect(closingBeforeStart(items, null, endOf)).toEqual([])
    expect(closingBeforeStart(items, NaN, endOf)).toEqual([])
  })
  it('formatStart: the time alone today, with the day otherwise', () => {
    const day = new Date(2026, 9, 3, 12, 0).getTime()
    expect(formatStart(day + 60_000, day)).toBe(new Date(day + 60_000).toLocaleString([], { hour: 'numeric', minute: '2-digit' }))
    const later = formatStart(day + 3 * 86_400_000, day)
    expect(later).toContain(new Date(day + 3 * 86_400_000).toLocaleDateString([], { weekday: 'short' }))
  })
  it('toLocalInput: local date and time for a datetime-local field', () => {
    expect(toLocalInput(new Date(2026, 0, 5, 7, 3))).toBe('2026-01-05T07:03')
  })
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
