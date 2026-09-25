import { describe, it, expect } from 'vitest'
import { findStuck } from '../../src/lib/watchHealth.js'

const NOW = 1_000_000
const w = (over = {}) => ({ reasons: new Map([['visible', 1]]), unsub: () => {}, attachedAt: NOW - 1_000, repairs: 0, ...over })

describe('findStuck', () => {
  it('ignores healthy, lingering and freshly attached watches', () => {
    const watches = new Map([
      ['live', w()],
      ['lingering', w({ reasons: new Map(), unsub: null })],
      ['fresh', w({ attachedAt: NOW - 9_999 })],
    ])
    expect(findStuck(watches, new Map([['live', {}]]), NOW)).toEqual([])
  })

  it('reports wanted items without a listener', () => {
    const watches = new Map([['item-001', w({ unsub: null, attachedAt: null })]])
    expect(findStuck(watches, new Map(), NOW)).toEqual([{ id: 'item-001', problem: 'no-listener' }])
  })

  it('reports listeners that delivered nothing for 10 s, at most 3 times', () => {
    const watches = new Map([
      ['item-001', w({ attachedAt: NOW - 10_000 })],
      ['item-002', w({ attachedAt: NOW - 60_000, repairs: 3 })],
    ])
    expect(findStuck(watches, new Map(), NOW)).toEqual([{ id: 'item-001', problem: 'no-data' }])
  })
})
