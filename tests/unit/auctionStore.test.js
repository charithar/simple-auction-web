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
const { viewFor, matchesFilter } = await import('../../src/lib/itemView.js')

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

describe('auction store: "Open" filter and ended items', () => {
  afterEach(() => vi.useRealTimers())

  const ts = (ms) => ({ toMillis: () => ms })
  const SETTINGS = { biddingOpen: true, minIncrement: 50, maxIncrement: null, antiSnipeSeconds: 120 }
  const onOpen = (auction) => {
    const item = auction.itemsById.get('item-001')
    return matchesFilter('open', viewFor(item, { settings: SETTINGS, uid: 'u1', myBidItemIds: new Set(), now: Date.now() }))
  }
  // A card on "Open": watched while shown, released (and detached 20 s later) when hidden.
  function setup(doc) {
    vi.useFakeTimers()
    const auction = signedIn()
    auction.settings = SETTINGS
    auction.catalog = [{ id: 'item-001', order: 1, endTime: doc.endTime }]
    const release = auction.watchItem('item-001', 'visible')
    listeners.at(-1).onItem({ id: 'item-001', currentAmount: 100, bidCount: 1, ...doc })
    return { auction, release }
  }

  it('an item seen ended stays hidden after its listener detaches (no 20 s loop)', () => {
    const end = ts(Date.now() - 60_000)
    const { auction, release } = setup({ endTime: end, lastBidAt: ts(Date.now() - 300_000) })
    expect(onOpen(auction)).toBe(false) // live and ended
    release() // the card is filtered out
    vi.advanceTimersByTime(20_000) // linger, then detach
    expect(auction.itemsById.get('item-001').live).toBe(false)
    expect(onOpen(auction)).toBe(false) // still hidden: it would otherwise reappear and loop
    expect(subscribeItem).toHaveBeenCalledTimes(1)

    // An admin moving the closing time changes the catalog endTime: show it again.
    auction.catalog = [{ id: 'item-001', order: 1, endTime: ts(Date.now() + 300_000) }]
    expect(onOpen(auction)).toBe(true)
  })

  it('an item still open when it detaches is shown even after its scheduled end', () => {
    // Scheduled end 30 s ago, but a bid 10 s ago extends it (anti-snipe 120 s).
    const { auction, release } = setup({ endTime: ts(Date.now() - 30_000), lastBidAt: ts(Date.now() - 10_000) })
    expect(onOpen(auction)).toBe(true)
    release()
    vi.advanceTimersByTime(20_000)
    expect(auction.itemsById.get('item-001').live).toBe(false)
    expect(onOpen(auction)).toBe(true) // may still be extended: keep the card so it can go live
  })
})
