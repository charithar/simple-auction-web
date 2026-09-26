// Admin operations against the emulator with real rules: npm run test:rules / test:docker.
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, setLogLevel, Timestamp, writeBatch } from 'firebase/firestore'
import {
  planImport, applyImport, resetItemBids, resetAllBids, extendItem, endItemIn, fetchItemBids, fetchAllBids, updateSettings,
  createUserCache,
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
  })

  it('bids reset between a warned preview and the apply: the price follows the new starting price', async () => {
    await importAs('admin', file(THREE))
    await raw((fs) => updateSettings(fs, { biddingOpen: true }))
    await placeBid(db('alice'), { itemId: 'item-001', uid: 'alice', amount: 100, settings: await raw(getSettings) })
    const plan = planImport(file(THREE.replace('title: One, startingPrice: 100', 'title: One, startingPrice: 150')), await raw(listItems))
    expect(plan.updates[0]).toMatchObject({ hasBids: true, warnings: ['startingPrice'] })

    await raw((fs) => updateSettings(fs, { biddingOpen: false }))
    const [one] = await raw(listItems)
    await resetItemBids(db('admin'), one, await raw(getSettings))
    await applyImport(db('admin'), plan)
    expect((await raw(listItems))[0]).toMatchObject({ startingPrice: 150, currentAmount: 150, bidCount: 0 })
  })

  it('an item deleted between preview and apply is not brought back', async () => {
    await importAs('admin', file(THREE))
    const plan = planImport(file(THREE.replace('title: Two,', 'title: Two (edited),')), await raw(listItems))
    await raw((fs) => deleteDoc(doc(fs, 'items/item-002')))

    await applyImport(db('admin'), plan)
    expect((await raw(listItems)).map((i) => i.id)).toEqual(['item-001', 'item-003'])
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

describe('extend', () => {
  it("extend moves the item's closing time", async () => {
    await importAs('admin', file(THREE))
    const settings = await raw(getSettings)
    const [item] = await raw(listItems)
    await extendItem(db('admin'), item, settings, 10 * 60_000)
    const [after] = await raw(listItems)
    expect(after.endTime.toMillis()).toBeGreaterThanOrEqual(item.endTime.toMillis() + 10 * 60_000)
  })
})

describe('reset all bids', () => {
  const allBids = () => raw((fs) => getDocs(collection(fs, 'items', 'item-001', 'bids')).then((a) =>
    Promise.all(['item-002', 'item-003'].map((id) => getDocs(collection(fs, 'items', id, 'bids')))).then((r) => a.size + r[0].size + r[1].size)))

  beforeEach(async () => {
    await importAs('admin', file(THREE))
    await raw((fs) => updateSettings(fs, { biddingOpen: true }))
    const settings = await raw(getSettings)
    await placeBid(db('alice'), { itemId: 'item-001', uid: 'alice', amount: 100, settings })
    await placeBid(db('bob'), { itemId: 'item-001', uid: 'bob', amount: 150, settings })
    await placeBid(db('bob'), { itemId: 'item-003', uid: 'bob', amount: 300, settings })
  })

  it('refuses while bidding is open, in the app and (with stale settings) in the rules', async () => {
    const items = await raw(listItems)
    await expect(resetAllBids(db('admin'), items, await raw(getSettings))).rejects.toThrow(/Pause bidding/)
    await assertFails(resetAllBids(db('admin'), items, { ...(await raw(getSettings)), biddingOpen: false }))
    expect(await allBids()).toBe(3)
  })

  it('non-admins cannot reset', async () => {
    await raw((fs) => updateSettings(fs, { biddingOpen: false }))
    await assertFails(resetAllBids(db('alice'), await raw(listItems), await raw(getSettings)))
  })

  it('puts every item back to its starting state and keeps everything else', async () => {
    await updateSettings(db('admin'), { biddingOpen: false, message: 'Back soon' })
    const before = await raw(listItems)
    const res = await resetAllBids(db('admin'), before, await raw(getSettings))
    expect(res).toEqual({ items: 3, bids: 3 })
    expect(await allBids()).toBe(0)
    const after = await raw(listItems)
    expect(after.map((i) => [i.id, i.currentAmount, i.bidCount, i.highBidderUid, i.lastBidAt]))
      .toEqual([['item-001', 100, 0, null, null], ['item-002', 200, 0, null, null], ['item-003', 300, 0, null, null]])
    after.forEach((it, i) => expect(it).toMatchObject({ title: before[i].title, endTime: before[i].endTime, specs: before[i].specs }))
    expect(await raw(getSettings)).toMatchObject({ biddingOpen: false, message: 'Back soon', minIncrement: 50 })
    expect((await raw((fs) => getDoc(doc(fs, 'users/alice')))).exists()).toBe(true)
    expect((await raw((fs) => getDoc(doc(fs, 'admins/admin')))).exists()).toBe(true)
  })

  it('bidding starts again from bid 1 at the starting price', async () => {
    await updateSettings(db('admin'), { biddingOpen: false })
    await resetAllBids(db('admin'), await raw(listItems), await raw(getSettings))
    await updateSettings(db('admin'), { biddingOpen: true })
    await expect(placeBid(db('bob'), { itemId: 'item-001', uid: 'bob', amount: 100, settings: await raw(getSettings) }))
      .resolves.toEqual({ bidCount: 1, amount: 100 })
  })

  it('handles an item with more bids than one batch can delete (> 500)', async () => {
    const N = 520
    await raw(async (fs) => {
      for (let start = 1; start <= N; start += 400) {
        const batch = writeBatch(fs)
        for (let n = start; n < Math.min(start + 400, N + 1); n++) {
          batch.set(doc(fs, 'items', 'item-002', 'bids', String(n)), { amount: 200 + n, uid: 'bob', createdAt: Timestamp.now() })
        }
        await batch.commit()
      }
      await setDoc(doc(fs, 'items/item-002'), { currentAmount: 200 + N, bidCount: N, highBidderUid: 'bob', lastBidAt: Timestamp.now() }, { merge: true })
    })
    await updateSettings(db('admin'), { biddingOpen: false })
    const item2 = (await raw(listItems))[1]
    expect(await resetItemBids(db('admin'), item2, await raw(getSettings))).toBe(N)
    expect((await raw(listItems))[1]).toMatchObject({ currentAmount: 200, bidCount: 0, highBidderUid: null })
    expect(await raw((fs) => getDocs(collection(fs, 'items', 'item-002', 'bids')).then((q) => q.size))).toBe(0)
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

  it('"End in 2m" sets the closing time two minutes from now, while bidding is open', async () => {
    const now = Date.now()
    await endItemIn(db('admin'), 'item-002', 2 * 60_000, now)
    expect((await raw(listItems))[1].endTime.toMillis()).toBe(now + 2 * 60_000)
    await assertFails(endItemIn(db('alice'), 'item-002', 2 * 60_000))
  })

  it('an item without a recent bid then closes on time; a late bid is refused', async () => {
    const t = Date.now()
    await endItemIn(db('admin'), 'item-002', 1_000, t)
    await new Promise((r) => setTimeout(r, 1_500))
    const settings = await raw(getSettings)
    // A client clock 1 s behind: its own check still sees the item open, the rules don't.
    const late = { itemId: 'item-002', uid: 'alice', amount: 200, settings, now: Date.now() - 1_000 }
    await expect(placeBid(db('alice'), late)).rejects.toMatchObject({ code: 'ended' })
    expect((await raw(listItems))[1].bidCount).toBe(0)
  })

  it('anti-sniping: with a bid in the last window the item stays open past it, and a new bid extends it', async () => {
    await endItemIn(db('admin'), 'item-001', 1_000) // bob bid just now: open until his bid + antiSnipeSeconds
    await new Promise((r) => setTimeout(r, 1_500))
    const settings = await raw(getSettings)
    await expect(placeBid(db('alice'), { itemId: 'item-001', uid: 'alice', amount: 200, settings }))
      .resolves.toEqual({ bidCount: 3, amount: 200 })
    const item = (await raw(listItems))[0]
    expect(item.lastBidAt.toMillis()).toBeGreaterThan(item.endTime.toMillis()) // accepted after the scheduled end
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
