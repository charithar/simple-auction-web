import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// The store with Firestore replaced: subscribeItem records its listeners so a
// test can decide whether (and what) they deliver.
const listeners = []
vi.mock('../../src/firebase.js', () => ({ db: {}, auth: {}, googleProvider: {}, useEmulators: false }))
vi.mock('../../src/lib/items.js', () => ({
  subscribeItem: vi.fn((db, id, onItem) => {
    const l = { id, onItem, unsub: vi.fn() }
    listeners.push(l)
    return l.unsub
  }),
  subscribeCatalog: vi.fn(() => () => {}),
  subscribeSettings: vi.fn(() => () => {}),
  subscribeMyBidItems: vi.fn(() => () => {}),
  cachedCatalog: vi.fn(async () => null),
  cachedItem: vi.fn(async () => null),
  cachedSettings: vi.fn(async () => null),
  cachedMyBidItems: vi.fn(async () => null),
}))

const { useAuctionStore } = await import('../../src/stores/auction.js')
const { useAuthStore } = await import('../../src/stores/auth.js')
const { subscribeItem, cachedItem } = await import('../../src/lib/items.js')

let warn
beforeEach(() => {
  listeners.length = 0
  subscribeItem.mockClear()
  setActivePinia(createPinia())
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const signedIn = () => {
  useAuthStore().user = { uid: 'u1' }
  return useAuctionStore()
}

describe('auction store: checkWatches', () => {
  it('leaves a healthy watch alone', () => {
    const auction = signedIn()
    auction.watchItem('item-001', 'visible')
    listeners[0].onItem({ id: 'item-001', currentAmount: 100 })
    expect(auction.checkWatches(Date.now() + 60_000)).toEqual([])
    expect(subscribeItem).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('re-subscribes a listener that delivered nothing for 10 s', () => {
    const auction = signedIn()
    auction.watchItem('item-001', 'visible')
    expect(auction.checkWatches(Date.now() + 5_000)).toEqual([])

    expect(auction.checkWatches(Date.now() + 10_000)).toEqual([{ id: 'item-001', problem: 'no-data' }])
    expect(listeners[0].unsub).toHaveBeenCalled()
    expect(subscribeItem).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0][0]).toMatch(/repaired 1 watched item\(s\): item-001 \(no-data; visible\)/)

    listeners[1].onItem({ id: 'item-001', currentAmount: 100 })
    expect(auction.checkWatches(Date.now() + 60_000)).toEqual([])
  })

  it('gives up on an item after 3 repairs (e.g. deleted), so it stops costing reads', () => {
    const auction = signedIn()
    auction.watchItem('item-001', 'visible')
    for (let i = 1; i <= 5; i++) auction.checkWatches(Date.now() + i * 10_000)
    expect(subscribeItem).toHaveBeenCalledTimes(4) // first attach + 3 repairs
  })

  it('attaches a wanted item that has no listener', () => {
    const auth = useAuthStore()
    const auction = useAuctionStore()
    auction.watchItem('item-001', 'open') // signed out: nothing attaches
    expect(subscribeItem).not.toHaveBeenCalled()
    expect(auction.checkWatches()).toEqual([]) // still signed out: skipped

    auth.user = { uid: 'u1' }
    expect(auction.checkWatches()).toEqual([{ id: 'item-001', problem: 'no-listener' }])
    expect(subscribeItem).toHaveBeenCalledTimes(1)
  })

  it('does not touch released (lingering) items', () => {
    const auction = signedIn()
    const release = auction.watchItem('item-001', 'visible')
    release()
    expect(auction.isWatching('item-001', 'visible')).toBe(false)
    expect(auction.checkWatches(Date.now() + 60_000)).toEqual([])
    expect(subscribeItem).toHaveBeenCalledTimes(1)
  })
})

describe('auction store: reload cooldown', () => {
  // Two page loads in the last minute: this one is the 3rd, so it starts cooling.
  beforeEach(() => {
    const loads = JSON.stringify([Date.now() - 2_000, Date.now() - 1_000])
    globalThis.localStorage = { getItem: () => loads, setItem: () => {}, removeItem: () => {} }
    cachedItem.mockClear()
  })
  afterEach(() => delete globalThis.localStorage)

  it('grid cards use the cache, but the item open in the dialog goes live', () => {
    const auction = signedIn()
    expect(auction.connection).toBe('cooldown')
    auction.watchItem('item-001', 'visible')
    expect(subscribeItem).not.toHaveBeenCalled()
    expect(cachedItem).toHaveBeenCalledTimes(1)

    auction.watchItem('item-002', 'open')
    auction.watchItem('item-001', 'open') // a cached card opened in the dialog
    expect(subscribeItem.mock.calls.map((c) => c[1])).toEqual(['item-002', 'item-001'])
  })
})

describe('auction store: tab opened in the background', () => {
  afterEach(() => {
    vi.useRealTimers()
    delete globalThis.document
  })

  it('pauses after 3 minutes even though it never got a visibilitychange', async () => {
    vi.useFakeTimers()
    globalThis.document = { visibilityState: 'hidden', addEventListener: vi.fn() }
    const auction = signedIn()
    auction.init()
    await nextTick()
    expect(auction.paused).toBe(false)
    vi.advanceTimersByTime(3 * 60_000)
    expect(auction.paused).toBe(true)
    expect(auction.connection).toBe('paused')
  })
})
