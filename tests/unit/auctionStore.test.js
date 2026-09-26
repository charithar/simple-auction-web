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

  it('a failed listener shows a reload message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { subscribeItems } = await import('../../src/lib/items.js')
    const auth = useAuthStore()
    const auction = useAuctionStore()
    auction.init()
    auth.user = { uid: 'u1' }
    await nextTick()
    const onError = subscribeItems.mock.calls.at(-1)[2]
    onError({ code: 'unavailable' })
    expect(auction.error).toMatch(/Reload the page/)
  })

  it('noteOwnBid marks an item as bid on before the listener confirms', () => {
    const auction = useAuctionStore()
    auction.noteOwnBid('item-003')
    expect(auction.myBidItemIds.has('item-003')).toBe(true)
  })
})
