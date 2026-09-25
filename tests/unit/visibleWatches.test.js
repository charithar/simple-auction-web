import { describe, it, expect, vi } from 'vitest'
import { useVisibleWatches } from '../../src/composables/useVisibleWatches.js'

// A stand-in for the auction store's watch bookkeeping: counts per id/reason.
function fakeStore() {
  const counts = new Map()
  const key = (id, reason) => `${id}:${reason}`
  return {
    counts,
    watchItem: vi.fn((id, reason) => {
      counts.set(key(id, reason), (counts.get(key(id, reason)) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        counts.set(key(id, reason), counts.get(key(id, reason)) - 1)
      }
    }),
    isWatching: (id, reason) => (counts.get(key(id, reason)) ?? 0) > 0,
    checkWatches: vi.fn(() => []),
    debugState: () => 'state',
    dropAll: () => counts.clear(), // the store losing track of every watch
  }
}

// Minimal IntersectionObserver double: the test drives the callbacks.
class FakeObserver {
  constructor(callback) {
    this.callback = callback
    this.targets = new Set()
    FakeObserver.last = this
  }
  observe(el) { this.targets.add(el) }
  unobserve(el) { this.targets.delete(el) }
  disconnect() { this.targets.clear() }
  fire(el, isIntersecting) { this.callback([{ target: el, isIntersecting }]) }
}

const card = () => ({ dataset: {} })

function setup() {
  const store = fakeStore()
  const log = vi.fn()
  const vw = useVisibleWatches(store, { Observer: FakeObserver, log })
  const io = FakeObserver.last
  const mount = (id) => {
    const el = card()
    vw.vWatchVisible.mounted(el, { value: id })
    return el
  }
  return { store, log, vw, io, mount }
}

describe('useVisibleWatches', () => {
  it('watches cards while they are on screen and releases them after', () => {
    const { store, io, mount, vw } = setup()
    const a = mount('item-001')
    const b = mount('item-002')
    io.fire(a, true)
    io.fire(b, true)
    expect(store.isWatching('item-001', 'visible')).toBe(true)
    io.fire(a, false)
    expect(store.isWatching('item-001', 'visible')).toBe(false)
    vw.vWatchVisible.unmounted(b)
    expect(store.isWatching('item-002', 'visible')).toBe(false)
  })

  it('reconcile is a no-op (apart from the store check) when everything is watched', () => {
    const { store, io, mount, vw, log } = setup()
    io.fire(mount('item-001'), true)
    expect(vw.reconcile()).toEqual([])
    expect(store.watchItem).toHaveBeenCalledTimes(1)
    expect(store.checkWatches).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
  })

  it('re-watches on-screen cards the store lost track of, and logs it', () => {
    const { store, io, mount, vw, log } = setup()
    const a = mount('item-001')
    const b = mount('item-002')
    const offScreen = mount('item-003')
    io.fire(a, true)
    io.fire(b, true)
    store.dropAll()

    expect(vw.reconcile()).toEqual(['item-001', 'item-002'])
    expect(store.isWatching('item-001', 'visible')).toBe(true)
    expect(store.isWatching('item-002', 'visible')).toBe(true)
    expect(store.isWatching(offScreen.dataset.itemId, 'visible')).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toMatch(/2 on-screen item\(s\) had no watch.*item-001, item-002/)

    // The stale release from before the drop must not undo the new watch:
    // scrolling away releases exactly the new one.
    io.fire(a, false)
    expect(store.isWatching('item-001', 'visible')).toBe(false)
    expect(store.counts.get('item-001:visible')).toBe(0)
  })

  it('stop releases everything', () => {
    const { store, io, mount, vw } = setup()
    io.fire(mount('item-001'), true)
    vw.stop()
    expect(store.isWatching('item-001', 'visible')).toBe(false)
  })
})
