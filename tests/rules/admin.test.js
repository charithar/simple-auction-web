// Admin operations against the emulator with real rules: npm run test:rules / test:docker.
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { collection, doc, getDoc, getDocs, setDoc, setLogLevel, Timestamp } from 'firebase/firestore'
import {
  planImport, applyImport, resetItemBids, extendItem, fetchItemBids, fetchAllBids, updateSettings, createUserCache,
} from '../../src/lib/admin.js'
import { placeBid } from '../../src/lib/bids.js'
import { parseAuctionFile } from '../../src/lib/importItems.js'

let env
const token = (uid) => ({ email: `${uid}@example.com`, email_verified: true, firebase: { sign_in_provider: 'google.com' } })
const db = (uid) => env.authenticatedContext(uid, token(uid)).firestore()
const raw = async (fn) => {
  let out
  await env.withSecurityRulesDisabled(async (ctx) => { out = await fn(ctx.firestore()) })
  return out
}
const listItems = (fs) => getDocs(collection(fs, 'items')).then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() })))
const getSettings = (fs) => getDoc(doc(fs, 'settings/auction')).then((s) => s.data())

const future = new Date(Date.now() + 3_600_000).toISOString()
const file = (items) => parseAuctionFile(`
auction: { title: Test, currency: Rs., minIncrement: 50, maxIncrement: 1000, endTime: "${future}", stagger: 1m }
items:
${items}`)
const THREE = `
  - { id: 1, title: One, startingPrice: 100, specs: { CPU: i5 } }
  - { id: 2, title: Two, startingPrice: 200 }
  - { id: 3, title: Three, startingPrice: 300 }`

beforeAll(async () => {
  setLogLevel('silent')
  env = await initializeTestEnvironment({
    projectId: 'demo-auction',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  })
})
afterAll(() => env?.cleanup())
beforeEach(async () => {
  await env.clearFirestore()
  await raw(async (fs) => {
    await setDoc(doc(fs, 'admins/admin'), {})
    for (const uid of ['admin', 'alice', 'bob']) {
      await setDoc(doc(fs, 'users', uid), { name: uid.toUpperCase(), email: `${uid}@example.com`, createdAt: Timestamp.now(), lastSeen: Timestamp.now() })
    }
  })
})

const importAs = async (uid, parsed, opts) => applyImport(db(uid), planImport(parsed, await raw(listItems)), opts)

describe('import', () => {
  it('creates settings (bidding closed) and items on first import', async () => {
    const res = await importAs('admin', file(THREE))
    expect(res).toEqual({ created: 3, updated: 0, removed: 0, skipped: [] })
    const settings = await raw(getSettings)
    expect(settings).toMatchObject({ title: 'Test', minIncrement: 50, biddingOpen: false, message: '' })
    const items = await raw(listItems)
    expect(items.map((i) => [i.id, i.currentAmount, i.bidCount])).toEqual([['item-001', 100, 0], ['item-002', 200, 0], ['item-003', 300, 0]])
    expect(items[0].specs).toEqual([{ name: 'CPU', value: 'i5' }])
  })

  it('non-admins cannot import', async () => {
    await assertFails(importAs('alice', file(THREE)))
  })

  it('re-import keeps bid state and biddingOpen, updates static fields', async () => {
    await importAs('admin', file(THREE))
    await raw((fs) => updateSettings(fs, { biddingOpen: true, message: 'Go!' }))
    const settings = await raw(getSettings)
    await placeBid(db('alice'), { itemId: 'item-001', uid: 'alice', amount: 100, settings })
    await placeBid(db('bob'), { itemId: 'item-001', uid: 'bob', amount: 150, settings })

    const res = await importAs('admin', file(THREE.replace('title: One, startingPrice: 100', 'title: One (edited), startingPrice: 120')
      .replace('title: Two, startingPrice: 200', 'title: Two, startingPrice: 250')))
    expect(res.updated).toBe(2)

    const [one, two] = await raw(listItems)
    expect(one).toMatchObject({ title: 'One (edited)', startingPrice: 120, currentAmount: 150, bidCount: 2, highBidderUid: 'bob' })
    expect(two).toMatchObject({ startingPrice: 250, currentAmount: 250, bidCount: 0 }) // no bids: price follows
    expect(await raw(getSettings)).toMatchObject({ biddingOpen: true, message: 'Go!' })
  })

  it('a bid that lands between preview and apply keeps its price and terms', async () => {
    await importAs('admin', file(THREE))
    await raw((fs) => updateSettings(fs, { biddingOpen: true }))
    const edited = file(THREE.replace('title: One, startingPrice: 100', 'title: One (edited), startingPrice: 150'))
    const plan = planImport(edited, await raw(listItems)) // preview: no bids yet
    expect(plan.updates[0].hasBids).toBe(false)
    await placeBid(db('alice'), { itemId: 'item-001', uid: 'alice', amount: 100, settings: await raw(getSettings) })

    const res = await applyImport(db('admin'), plan)
    expect(res.skipped).toEqual(['item-001'])
    const [one] = await raw(listItems)
    expect(one).toMatchObject({ title: 'One (edited)', startingPrice: 100, currentAmount: 100, bidCount: 1, highBidderUid: 'alice' })
    const catalog = (await raw((fs) => getDoc(doc(fs, 'catalog/items')))).data()
    expect(catalog.items['item-001']).toMatchObject({ title: 'One (edited)', startingPrice: 100 })
  })

  it('removeMissing deletes only items without bids', async () => {
    await importAs('admin', file(THREE))
    await raw((fs) => updateSettings(fs, { biddingOpen: true }))
    await placeBid(db('alice'), { itemId: 'item-003', uid: 'alice', amount: 300, settings: await raw(getSettings) })

    const res = await importAs('admin', file('  - { id: 1, title: One, startingPrice: 100, specs: { CPU: i5 } }'), { removeMissing: true })
    expect(res.removed).toBe(1)
    expect((await raw(listItems)).map((i) => i.id)).toEqual(['item-001', 'item-003'])
  })
})

describe('catalog', () => {
  const getCatalog = (fs) => getDoc(doc(fs, 'catalog/items')).then((s) => s.data())

  it('import writes one catalog doc with display data for every item', async () => {
    await importAs('admin', file(THREE))
    const cat = await raw(getCatalog)
    expect(Object.keys(cat.items)).toEqual(['item-001', 'item-002', 'item-003'])
    expect(cat.items['item-001']).toMatchObject({ order: 1, title: 'One', startingPrice: 100, specs: [{ name: 'CPU', value: 'i5' }] })
    expect(cat.items['item-001']).not.toHaveProperty('bidCount')
  })

  it('removed items leave the catalog; kept items without file entries stay', async () => {
    await importAs('admin', file(THREE))
    await importAs('admin', file('  - { id: 1, title: One, startingPrice: 100, specs: { CPU: i5 } }'), { removeMissing: false })
    expect(Object.keys((await raw(getCatalog)).items)).toEqual(['item-001', 'item-002', 'item-003'])
    await importAs('admin', file('  - { id: 1, title: One, startingPrice: 100, specs: { CPU: i5 } }'), { removeMissing: true })
    expect(Object.keys((await raw(getCatalog)).items)).toEqual(['item-001'])
  })

  it('extend updates the item and its catalog entry together', async () => {
    await importAs('admin', file(THREE))
    const settings = await raw(getSettings)
    const [item] = await raw(listItems)
    await extendItem(db('admin'), item, settings, 10 * 60_000)
    const [after] = await raw(listItems)
    const cat = await raw(getCatalog)
    expect(cat.items['item-001'].endTime.toMillis()).toBe(after.endTime.toMillis())
    expect(cat.items['item-001'].title).toBe('One') // merge kept the other fields
  })

  it('signed-in users can read it, guests and non-admin writers cannot', async () => {
    await importAs('admin', file(THREE))
    await assertSucceeds(getDoc(doc(db('alice'), 'catalog/items')))
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'catalog/items')))
    await assertFails(setDoc(doc(db('alice'), 'catalog/items'), { items: {} }))
  })

  it('plan flags a missing or stale catalog even when items are unchanged', async () => {
    await importAs('admin', file(THREE))
    const items = await raw(listItems)
    expect(planImport(file(THREE), items, null).catalogStale).toBe(true)
    const { catalogItems } = await import('../../src/lib/catalog.js')
    const entries = catalogItems(await raw(getCatalog))
    expect(planImport(file(THREE), items, entries).catalogStale).toBe(false)
  })
})

describe('item controls', () => {
  beforeEach(async () => {
    await importAs('admin', file(THREE))
    await raw((fs) => updateSettings(fs, { biddingOpen: true }))
    const settings = await raw(getSettings)
    await placeBid(db('alice'), { itemId: 'item-001', uid: 'alice', amount: 100, settings })
    await placeBid(db('bob'), { itemId: 'item-001', uid: 'bob', amount: 150, settings })
  })

  it('reset refuses while bidding is open', async () => {
    const [item] = await raw(listItems)
    await expect(resetItemBids(db('admin'), item, await raw(getSettings))).rejects.toThrow(/Pause bidding/)
  })

  it('reset is refused by the rules while bidding is open, even with stale settings', async () => {
    const [item] = await raw(listItems)
    await assertFails(resetItemBids(db('admin'), item, { ...(await raw(getSettings)), biddingOpen: false }))
    expect((await raw(listItems))[0].bidCount).toBe(2)
  })

  it('reset deletes bids and restores the starting price; bidding works again from bid 1', async () => {
    await updateSettings(db('admin'), { biddingOpen: false })
    const [item] = await raw(listItems)
    expect(await resetItemBids(db('admin'), item, await raw(getSettings))).toBe(2)
    const [after] = await raw(listItems)
    expect(after).toMatchObject({ currentAmount: 100, bidCount: 0, highBidderUid: null, lastBidAt: null })
    expect((await raw((fs) => getDocs(collection(fs, 'items/item-001/bids')))).size).toBe(0)

    await updateSettings(db('admin'), { biddingOpen: true })
    await assertSucceeds(placeBid(db('alice'), { itemId: 'item-001', uid: 'alice', amount: 100, settings: await raw(getSettings) }))
  })

  it('non-admins cannot reset or extend', async () => {
    await raw((fs) => updateSettings(fs, { biddingOpen: false }))
    const [item] = await raw(listItems)
    const settings = await raw(getSettings)
    await assertFails(resetItemBids(db('alice'), item, settings))
    await assertFails(extendItem(db('alice'), item, settings, 60_000))
  })

  it('extend pushes the end from the effective end (or now, if already ended)', async () => {
    const settings = await raw(getSettings)
    const [item] = await raw(listItems)
    await extendItem(db('admin'), item, settings, 5 * 60_000)
    const [after] = await raw(listItems)
    expect(after.endTime.toMillis()).toBe(item.endTime.toMillis() + 5 * 60_000)

    const ended = { ...item, endTime: Timestamp.fromMillis(Date.now() - 3_600_000), lastBidAt: null }
    const now = Date.now()
    await extendItem(db('admin'), ended, settings, 60_000, now)
    const [reopened] = await raw(listItems)
    expect(reopened.endTime.toMillis()).toBe(now + 60_000)
  })

  it('admin can read bid history, all bids and user details', async () => {
    const bids = await fetchItemBids(db('admin'), 'item-001')
    expect(bids.map((b) => [b.n, b.amount, b.uid])).toEqual([[2, 150, 'bob'], [1, 100, 'alice']])
    expect((await fetchAllBids(db('admin'))).length).toBe(2)
    const user = createUserCache(db('admin'))
    expect(await user('bob')).toMatchObject({ name: 'BOB', email: 'bob@example.com' })
  })

  it('bidders cannot read the full history or other users', async () => {
    await assertFails(fetchItemBids(db('alice'), 'item-001'))
    await assertFails(fetchAllBids(db('alice')))
    expect(await createUserCache(db('alice'))('bob')).toBeNull()
  })
})
