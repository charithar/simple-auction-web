import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// The store with Firestore replaced: each subscribe* records its callbacks.
const subs = {}
const unsub = vi.fn()
const record = (name) => vi.fn((db, ...rest) => {
  const [a, b] = rest
  subs[name] = typeof a === 'function' ? a : b // subscribeMyBidItems takes uid first
  return unsub
})
vi.mock('../../src/firebase.js', () => ({ db: {}, auth: {}, googleProvider: {}, useEmulators: false }))
vi.mock('../../src/lib/items.js', () => ({
  subscribeItems: record('items'),
  subscribeSettings: record('settings'),
  subscribeMyBidItems: record('mine'),
}))

const { useAuctionStore } = await import('../../src/stores/auction.js')
const { useAuthStore } = await import('../../src/stores/auth.js')

beforeEach(() => {
  for (const k of Object.keys(subs)) delete subs[k]
  unsub.mockClear()
  setActivePinia(createPinia())
})

describe('auction store', () => {
  it('listens to settings, all items and own bids while signed in', async () => {
    const auth = useAuthStore()
    const auction = useAuctionStore()
    auction.init()
    expect(Object.keys(subs)).toEqual([])
    expect(auction.connection).toBe('connecting')

    auth.user = { uid: 'u1' }
    await nextTick()
    expect(Object.keys(subs).sort()).toEqual(['items', 'mine', 'settings'])

    subs.items([{ id: 'item-001', order: 1 }, { id: 'item-002', order: 2 }])
    subs.mine(new Set(['item-002']))
    expect(auction.loaded).toBe(true)
    expect(auction.connection).toBe('live')
    expect(auction.itemsById.get('item-002')).toMatchObject({ order: 2 })
    expect([...auction.myBidItemIds]).toEqual(['item-002'])
  })

  it('signing out stops the listeners and clears the data', async () => {
    const auth = useAuthStore()
    const auction = useAuctionStore()
    auction.init()
    auth.user = { uid: 'u1' }
    await nextTick()
    subs.items([{ id: 'item-001', order: 1 }])

    auth.user = null
    await nextTick()
    expect(unsub).toHaveBeenCalledTimes(3)
    expect(auction.items).toEqual([])
    expect(auction.loaded).toBe(false)
  })

  it('a failed listener says it is reconnecting', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { subscribeItems } = await import('../../src/lib/items.js')
    const auth = useAuthStore()
    const auction = useAuctionStore()
    auction.init()
    auth.user = { uid: 'u1' }
    await nextTick()
    const onError = subscribeItems.mock.calls.at(-1)[2]
    onError({ code: 'unavailable' })
    expect(auction.error).toBe('Lost connection to the auction. Reconnecting automatically…')
    expect(auction.connection).toBe('reconnecting')
  })

  it('noteOwnBid marks an item as bid on before the listener confirms', () => {
    const auction = useAuctionStore()
    auction.noteOwnBid('item-003')
    expect(auction.myBidItemIds.has('item-003')).toBe(true)
  })

  describe('own bid shown until the item listener confirms it', () => {
    const doc = (over = {}) => ({ id: 'item-001', order: 1, currentAmount: 100, bidCount: 0, highBidderUid: null, ...over })
    async function signedIn() {
      const auth = useAuthStore()
      const auction = useAuctionStore()
      auction.init()
      auth.user = { uid: 'u1' }
      await nextTick()
      subs.items([doc()])
      return { auth, auction }
    }

    it('a first bid shows as winning at once, not as outbid while the item update is on its way', async () => {
      const { auction } = await signedIn()
      auction.noteOwnBid('item-001', { bidCount: 1, amount: 100 })
      subs.mine(new Set(['item-001'])) // "my bids" can arrive before the item update
      expect(auction.itemsById.get('item-001')).toMatchObject({ highBidderUid: 'u1', bidCount: 1, currentAmount: 100 })
      expect(auction.items[0].highBidderUid).toBe('u1')
    })

    it('the real doc takes over once the listener has the bid', async () => {
      const { auction } = await signedIn()
      auction.noteOwnBid('item-001', { bidCount: 1, amount: 100 })
      subs.items([doc({ bidCount: 1, highBidderUid: 'u1', lastBidAt: 'server-time' })])
      expect(auction.itemsById.get('item-001')).toMatchObject({ bidCount: 1, lastBidAt: 'server-time' })
      subs.items([doc({ bidCount: 2, currentAmount: 150, highBidderUid: 'rival' })])
      expect(auction.itemsById.get('item-001')).toMatchObject({ bidCount: 2, highBidderUid: 'rival' })
    })

    it('a rival bid that lands first overrides it (the bidder really is outbid)', async () => {
      const { auction } = await signedIn()
      auction.noteOwnBid('item-001', { bidCount: 1, amount: 100 })
      subs.items([doc({ bidCount: 2, currentAmount: 150, highBidderUid: 'rival' })])
      expect(auction.itemsById.get('item-001')).toMatchObject({ bidCount: 2, currentAmount: 150, highBidderUid: 'rival' })
    })

    it('updates for other items leave it in place; signing out clears it', async () => {
      const { auth, auction } = await signedIn()
      auction.noteOwnBid('item-001', { bidCount: 1, amount: 100 })
      subs.items([doc(), { id: 'item-002', order: 2, currentAmount: 50, bidCount: 3, highBidderUid: 'x' }])
      expect(auction.itemsById.get('item-001').highBidderUid).toBe('u1')
      auth.user = null
      await nextTick()
      auth.user = { uid: 'u1' }
      await nextTick()
      subs.items([doc()])
      expect(auction.itemsById.get('item-001').highBidderUid).toBeNull()
    })
  })
})
