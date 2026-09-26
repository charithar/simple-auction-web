import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// stores/auction.js paths not covered by auctionStore.test.js.
const calls = []
vi.mock('../../src/firebase.js', () => ({ db: {}, auth: {}, googleProvider: {}, useEmulators: false }))
vi.mock('../../src/lib/items.js', () => {
  const record = (name) => vi.fn((...args) => {
    calls.push({ name, args })
    return () => {}
  })
  return { subscribeItems: record('items'), subscribeSettings: record('settings'), subscribeMyBidItems: record('mine') }
})

const { useAuctionStore } = await import('../../src/stores/auction.js')
const { useAuthStore } = await import('../../src/stores/auth.js')
const callback = (name, i) => calls.filter((c) => c.name === name).at(-1).args[i]

beforeEach(() => {
  calls.length = 0
  setActivePinia(createPinia())
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

async function signedIn() {
  const auction = useAuctionStore()
  auction.init()
  useAuthStore().user = { uid: 'u1' }
  await nextTick()
  return auction
}

describe('auction store edges', () => {
  it('init is idempotent: one set of listeners per sign-in', async () => {
    const auction = await signedIn()
    auction.init()
    await nextTick()
    expect(calls.map((c) => c.name).sort()).toEqual(['items', 'mine', 'settings'])
  })

  it('settings updates reach the store; a deleted settings doc becomes null', async () => {
    const auction = await signedIn()
    callback('settings', 1)({ biddingOpen: true, title: 'T' })
    expect(auction.settings).toEqual({ biddingOpen: true, title: 'T' })
    callback('settings', 1)(null)
    expect(auction.settings).toBeNull()
  })

  it('a quota error says "over capacity", not "reload"', async () => {
    const auction = await signedIn()
    callback('settings', 2)({ code: 'resource-exhausted' })
    expect(auction.error).toBe('The auction is temporarily over capacity. Please try again later.')
  })

  it('a refusal (emergency stop on) says the auction is temporarily unavailable', async () => {
    const auction = await signedIn()
    callback('items', 2)({ code: 'permission-denied' })
    expect(auction.error).toBe('The auction is temporarily unavailable. Try reloading in a few minutes.')
  })

  it('new item data clears an earlier listener error', async () => {
    const auction = await signedIn()
    callback('settings', 2)({ code: 'unavailable' })
    expect(auction.error).not.toBe('')
    callback('items', 1)([{ id: 'item-001', order: 1 }])
    expect(auction.error).toBe('')
  })

  it('noteOwnBid on an item already marked keeps the same set (no needless re-render)', async () => {
    const auction = await signedIn()
    callback('mine', 2)(new Set(['item-001']))
    const before = auction.myBidItemIds
    auction.noteOwnBid('item-001')
    expect(auction.myBidItemIds).toBe(before)
  })

  it('switching accounts re-attaches the listeners for the new user', async () => {
    const auction = await signedIn()
    useAuthStore().user = { uid: 'u2' }
    await nextTick()
    expect(calls.filter((c) => c.name === 'mine').map((c) => c.args[1])).toEqual(['u1', 'u2'])
    expect(auction.loaded).toBe(false) // until the new user's items arrive
  })
})
