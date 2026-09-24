import { describe, it, expect } from 'vitest'
import { cooldownFor, registerPageLoad, readCached, writeCached } from '../../src/lib/loadGuard.js'

const memoryStorage = () => {
  const m = new Map()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
const T = 1_000_000_000_000

describe('cooldownFor', () => {
  it('first two loads in a minute are free', () => {
    expect(cooldownFor([], T)).toBe(0)
    expect(cooldownFor([T - 10_000], T)).toBe(0)
  })
  it('escalates 15s, 30s, 60s', () => {
    expect(cooldownFor([T - 20_000, T - 10_000], T)).toBe(15_000)
    expect(cooldownFor([T - 30_000, T - 20_000, T - 10_000], T)).toBe(30_000)
    expect(cooldownFor([T - 40_000, T - 30_000, T - 20_000, T - 10_000], T)).toBe(60_000)
    expect(cooldownFor(Array.from({ length: 10 }, (_, i) => T - i * 1000 - 1), T)).toBe(60_000)
  })
  it('only counts the last minute', () => {
    expect(cooldownFor([T - 120_000, T - 90_000, T - 61_000], T)).toBe(0)
  })
})

describe('registerPageLoad', () => {
  it('records loads across calls (shared by tabs via storage)', () => {
    const s = memoryStorage()
    expect(registerPageLoad(T, s).cooldownMs).toBe(0)
    expect(registerPageLoad(T + 5_000, s).cooldownMs).toBe(0)
    expect(registerPageLoad(T + 10_000, s).cooldownMs).toBe(15_000)
    expect(registerPageLoad(T + 200_000, s).cooldownMs).toBe(0)
  })
  it('survives missing or corrupt storage', () => {
    expect(registerPageLoad(T, null).cooldownMs).toBe(0)
    const s = memoryStorage()
    s.setItem('auction.loads', '{oops')
    expect(registerPageLoad(T, s).cooldownMs).toBe(0)
  })
})

describe('readCached / writeCached', () => {
  it('expires entries', () => {
    const s = memoryStorage()
    writeCached('k', { a: 1 }, T, s)
    expect(readCached('k', 60_000, T + 59_000, s)).toEqual({ a: 1 })
    expect(readCached('k', 60_000, T + 61_000, s)).toBeNull()
    expect(readCached('missing', 60_000, T, s)).toBeNull()
  })
})
