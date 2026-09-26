import { describe, it, expect, vi } from 'vitest'

// lib/items.js subscribeItems with Firestore's onSnapshot replaced, to pin the
// listener options (the emulator can't show the difference: see
// scripts/browser/killswitch.mjs for the end-to-end check).
vi.mock('firebase/firestore', () => ({
  collection: (db, path) => ({ path }),
  collectionGroup: vi.fn(),
  doc: vi.fn(),
  orderBy: (f) => ({ orderBy: f }),
  query: (c, ...rest) => ({ ...c, rest }),
  where: vi.fn(),
  onSnapshot: vi.fn(() => () => {}),
}))

const { onSnapshot } = await import('firebase/firestore')
const { subscribeItems } = await import('../../src/lib/items.js')

const snap = ({ fromCache, changes = 0 }) => ({
  docs: [{ id: 'item-001', data: () => ({ order: 1 }) }],
  metadata: { fromCache },
  docChanges: () => Array.from({ length: changes }),
})

describe('subscribeItems', () => {
  it('listens with metadata changes, so a reconnect sees the server confirm unchanged cached data', () => {
    subscribeItems({}, () => {}, () => {})
    const [q, options] = onSnapshot.mock.calls.at(-1)
    expect(q).toMatchObject({ path: 'items', rest: [{ orderBy: 'order' }] })
    expect(options).toEqual({ includeMetadataChanges: true })
  })

  it('passes the items, whether they came from the cache, and the billed changes', () => {
    const onItems = vi.fn()
    const onChangeCount = vi.fn()
    subscribeItems({}, onItems, () => {}, onChangeCount)
    const next = onSnapshot.mock.calls.at(-1)[2]
    next(snap({ fromCache: true, changes: 20 })) // cached data after a reconnect
    next(snap({ fromCache: false, changes: 0 })) // the server confirms it: metadata only, not billed
    expect(onItems.mock.calls.map((c) => c[1])).toEqual([true, false])
    expect(onItems.mock.calls[0][0]).toEqual([{ id: 'item-001', order: 1 }])
    expect(onChangeCount.mock.calls.map((c) => c[0])).toEqual([20, 0])
  })
})
