// The app's live listeners (src/lib/items.js) for real against the emulator and
// the real rules, plus admin paths not covered by admin.test.js.
// npm run test:rules / test:docker / test:coverage.
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, setLogLevel, Timestamp, updateDoc } from 'firebase/firestore'
import { subscribeItems, subscribeSettings, subscribeMyBidItems, subscribeKillSwitch } from '../../src/lib/items.js'
import { planImport, applyImport, setItemEnd, createUserCache, updateSettings, setKillSwitch } from '../../src/lib/admin.js'
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
const HOUR = 3_600_000
const SETTINGS = { title: 'T', biddingOpen: true, minIncrement: 50, maxIncrement: null, antiSnipeSeconds: 120 }
const itemDoc = (order, over = {}) => ({
  order, title: `Lot ${order}`, currency: 'Rs.', startingPrice: 100, currentAmount: 100, bidCount: 0,
  highBidderUid: null, lastBidAt: null, endTime: Timestamp.fromMillis(Date.now() + HOUR), ...over,
})

// Collects a listener's snapshots; nth(n) waits until n have arrived and returns the nth.
function recorder() {
  const values = []
  const waiters = []
  const push = (v) => {
    values.push(v)
    waiters.splice(0).forEach((w) => w())
  }
  const nth = async (n) => {
    while (values.length < n) await new Promise((r) => waiters.push(r))
    return values[n - 1]
  }
  return { values, push, nth }
}

beforeAll(async () => {
  setLogLevel('silent')
  env = await initializeTestEnvironment({ projectId: 'demo-auction', firestore: { rules: readFileSync('firestore.rules', 'utf8') } })
})
afterAll(() => env?.cleanup())
beforeEach(async () => {
  await env.clearFirestore()
  await raw(async (fs) => {
    await setDoc(doc(fs, 'admins/admin'), {})
    await setDoc(doc(fs, 'settings/auction'), SETTINGS)
    for (const uid of ['admin', 'alice', 'bob']) {
      await setDoc(doc(fs, 'users', uid), { name: uid, email: `${uid}@example.com`, createdAt: Timestamp.now(), lastSeen: Timestamp.now() })
    }
    await setDoc(doc(fs, 'items/item-003'), itemDoc(3))
    await setDoc(doc(fs, 'items/item-001'), itemDoc(1))
    await setDoc(doc(fs, 'items/item-002'), itemDoc(2))
  })
})

describe('subscribeItems', () => {
  it('delivers every item in lot order, and counts the changed docs (billed reads)', async () => {
    const items = recorder()
    const changes = recorder()
    const unsub = subscribeItems(db('alice'), items.push, (e) => { throw e }, changes.push)
    expect((await items.nth(1)).map((i) => i.id)).toEqual(['item-001', 'item-002', 'item-003'])
    expect(await changes.nth(1)).toBe(3) // the page load reads every item

    await placeBid(db('bob'), { itemId: 'item-002', uid: 'bob', amount: 100, settings: SETTINGS })
    const after = await items.nth(2)
    expect(after.find((i) => i.id === 'item-002')).toMatchObject({ currentAmount: 100, bidCount: 1, highBidderUid: 'bob' })
    expect(await changes.nth(2)).toBe(1) // a bid costs one read per listener
    unsub()
  })

  it('signed-out visitors get a permission error, not data', async () => {
    const err = await new Promise((resolve) => subscribeItems(env.unauthenticatedContext().firestore(), () => resolve(null), resolve))
    expect(err).toMatchObject({ code: 'permission-denied' })
  })
})

describe('subscribeSettings', () => {
  it('delivers the settings and null once the doc is gone', async () => {
    const s = recorder()
    const unsub = subscribeSettings(db('alice'), s.push, (e) => { throw e })
    expect(await s.nth(1)).toMatchObject({ title: 'T', biddingOpen: true })
    await raw((fs) => deleteDoc(doc(fs, 'settings/auction')))
    expect(await s.nth(2)).toBeNull()
    unsub()
  })
})

describe('subscribeKillSwitch', () => {
  it('tells the admin page whether the emergency stop is on', async () => {
    const s = recorder()
    const unsub = subscribeKillSwitch(db('admin'), s.push, (e) => { throw e })
    expect(await s.nth(1)).toBe(false)
    await setKillSwitch(db('admin'), true)
    expect(await s.nth(2)).toBe(true)
    await setKillSwitch(db('admin'), false)
    expect(await s.nth(3)).toBe(false)
    unsub()
  })
})

describe('subscribeMyBidItems', () => {
  it('only the user\'s own bids, as item ids, updated when they bid', async () => {
    await placeBid(db('bob'), { itemId: 'item-001', uid: 'bob', amount: 100, settings: SETTINGS })
    await placeBid(db('alice'), { itemId: 'item-003', uid: 'alice', amount: 100, settings: SETTINGS })
    const mine = recorder()
    const unsub = subscribeMyBidItems(db('alice'), 'alice', mine.push, (e) => { throw e })
    expect([...(await mine.nth(1))]).toEqual(['item-003'])
    await placeBid(db('alice'), { itemId: 'item-001', uid: 'alice', amount: 150, settings: SETTINGS })
    expect([...(await mine.nth(2))].sort()).toEqual(['item-001', 'item-003'])
    unsub()
  })

  it('asking for someone else\'s bids is refused', async () => {
    const err = await new Promise((resolve) => subscribeMyBidItems(db('alice'), 'bob', () => resolve(null), resolve))
    expect(err).toMatchObject({ code: 'permission-denied' })
  })
})

describe('admin paths', () => {
  const future = new Date(Date.now() + HOUR).toISOString()
  const file = (items) => parseAuctionFile(`auction: { title: T, currency: Rs., minIncrement: 50, endTime: "${future}" }\nitems:\n${items}`)

  it('setItemEnd sets the closing time; bidders see it', async () => {
    const at = new Date(Date.now() + 2 * HOUR)
    await setItemEnd(db('admin'), 'item-001', at)
    expect((await raw(listItems)).find((i) => i.id === 'item-001').endTime.toMillis()).toBe(at.getTime())
    await expect(setItemEnd(db('alice'), 'item-001', at)).rejects.toMatchObject({ code: 'permission-denied' })
  })

  it('re-import moves a closing time and removes a per-item increment override', async () => {
    await raw((fs) => updateDoc(doc(fs, 'items/item-001'), { minIncrement: 500 }))
    const later = new Date(Date.now() + 3 * HOUR).toISOString()
    const parsed = file(`  - { id: 1, title: Lot 1, startingPrice: 100, endTime: "${later}" }`)
    const plan = planImport(parsed, await raw(listItems))
    expect(plan.updates[0].changes).toEqual(expect.arrayContaining(['endTime', 'minIncrement']))
    await applyImport(db('admin'), plan)
    const one = (await raw(listItems)).find((i) => i.id === 'item-001')
    expect(one.endTime.toMillis()).toBe(Date.parse(later))
    expect(one).not.toHaveProperty('minIncrement')
  })

  it('a closing-time change on an item that got its first bid after the preview is not applied', async () => {
    const later = new Date(Date.now() + 3 * HOUR).toISOString()
    const plan = planImport(file(`  - { id: 1, title: Lot 1, startingPrice: 100, endTime: "${later}" }`), await raw(listItems))
    const before = (await raw(listItems)).find((i) => i.id === 'item-001').endTime.toMillis()
    await placeBid(db('alice'), { itemId: 'item-001', uid: 'alice', amount: 100, settings: await raw(getSettings) })
    const res = await applyImport(db('admin'), plan)
    expect(res.skipped).toEqual(['item-001'])
    expect((await raw(listItems)).find((i) => i.id === 'item-001').endTime.toMillis()).toBe(before)
  })

  it('when the only change is refused (bid after the preview), nothing is written', async () => {
    const at = new Date(Date.now() + HOUR).toISOString()
    const later = new Date(Date.now() + 3 * HOUR).toISOString()
    const line = (end) => `  - { id: 1, title: Lot 1, startingPrice: 100, endTime: "${end}" }`
    await applyImport(db('admin'), planImport(file(line(at)), [])) // the item as imported
    const plan = planImport(file(line(later)), await raw(listItems))
    expect(plan.updates[0].changes).toEqual(['endTime'])
    await placeBid(db('alice'), { itemId: 'item-001', uid: 'alice', amount: 100, settings: await raw(getSettings) })
    const before = (await raw(listItems)).find((i) => i.id === 'item-001')
    const res = await applyImport(db('admin'), plan)
    expect(res.skipped).toEqual(['item-001'])
    expect((await raw(listItems)).find((i) => i.id === 'item-001')).toEqual(before)
  })

  it('the user cache reads each bidder once per session', async () => {
    const lookup = createUserCache(db('admin'))
    const first = lookup('alice')
    expect(lookup('alice')).toBe(first) // same pending read, not a second one
    expect(await first).toMatchObject({ name: 'alice', email: 'alice@example.com' })
    expect(await lookup('nobody')).toBeNull()
  })

  it('updateSettings merges (bidding state and message survive a partial update)', async () => {
    await updateSettings(db('admin'), { message: 'Back at 3' })
    expect(await raw(getSettings)).toMatchObject({ ...SETTINGS, message: 'Back at 3' })
  })
})
