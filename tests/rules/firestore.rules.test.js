// Runs against the Firestore emulator: npm run test:rules (requires Java).
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing'
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, writeBatch, Timestamp, serverTimestamp,
  collectionGroup, query, where, getDocs, setLogLevel,
} from 'firebase/firestore'
import { placeBid } from '../../src/lib/bids.js'
import { minNextBid, maxNextBid } from '../../src/lib/auction.js'
import { setEscalation } from '../../src/lib/admin.js'
import { renderRules, RULES_TEMPLATE } from '../../scripts/build-rules.mjs'

const SETTINGS = { biddingOpen: true, minIncrement: 50, maxIncrement: 1000, antiSnipeSeconds: 120 }
const HOUR = 3_600_000

let env

const googleToken = (uid) => ({
  email: `${uid}@example.com`,
  email_verified: true,
  firebase: { sign_in_provider: 'google.com' },
})
const db = (uid) => env.authenticatedContext(uid, googleToken(uid)).firestore()
const anonDb = (uid) =>
  env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore()
const guestDb = () => env.unauthenticatedContext().firestore()

const baseItem = (over = {}) => ({
  title: 'Optiplex 5040',
  currency: 'Rs.',
  startingPrice: 5000,
  currentAmount: 5000,
  bidCount: 0,
  highBidderUid: null,
  lastBidAt: null,
  endTime: Timestamp.fromMillis(Date.now() + HOUR),
  ...over,
})

const seed = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()))

const user = (uid) => ({
  name: uid, email: `${uid}@example.com`,
  // Last seen an hour ago, so the once-a-minute lastSeen cooldown doesn't apply.
  createdAt: Timestamp.fromMillis(Date.now() - HOUR), lastSeen: Timestamp.fromMillis(Date.now() - HOUR),
})

// A bid written directly (bypassing client validation) so the rules alone decide.
const rawBid = (fs, itemId, { n, amount, uid, itemUid = uid, bidAmount = amount, lastBidAt, extra = {}, skipBidDoc = false, skipItem = false }) => {
  const batch = writeBatch(fs)
  if (!skipItem) {
    batch.update(doc(fs, 'items', itemId), {
      currentAmount: amount, highBidderUid: itemUid, bidCount: n,
      lastBidAt: lastBidAt ?? serverTimestamp(), ...extra,
    })
  }
  if (!skipBidDoc) {
    batch.set(doc(fs, 'items', itemId, 'bids', String(n)), {
      amount: bidAmount, uid, createdAt: serverTimestamp(),
    })
  }
  return batch.commit()
}

beforeAll(async () => {
  // assertFails() cases make the SDK log every PERMISSION_DENIED; failures still surface via assertions.
  setLogLevel('silent')
  env = await initializeTestEnvironment({
    projectId: 'demo-auction',
    // Rendered like a deploy, with a placeholder domain (the real one is only in the environment).
    firestore: { rules: renderRules(readFileSync(RULES_TEMPLATE, 'utf8'), ['allowed.test']) },
  })
})

afterAll(() => env?.cleanup())

beforeEach(async () => {
  await env.clearFirestore()
  await seed(async (fs) => {
    await setDoc(doc(fs, 'settings/auction'), SETTINGS)
    await setDoc(doc(fs, 'items/item1'), baseItem())
    await setDoc(doc(fs, 'items/item2'), baseItem({ minIncrement: 500, maxIncrement: 2000 }))
    for (const uid of ['alice', 'bob', 'admin']) await setDoc(doc(fs, 'users', uid), user(uid))
    await setDoc(doc(fs, 'admins/admin'), {})
  })
})

describe('reads', () => {
  it('guests cannot read items or settings', async () => {
    await assertFails(getDoc(doc(guestDb(), 'items/item1')))
    await assertFails(getDoc(doc(guestDb(), 'settings/auction')))
  })
  it('signed-in users can read items and settings', async () => {
    await assertSucceeds(getDoc(doc(db('alice'), 'items/item1')))
    await assertSucceeds(getDoc(doc(db('alice'), 'settings/auction')))
  })
})

describe('allowed domains', () => {
  const as = (uid, email, over = {}) => env.authenticatedContext(uid, {
    email, email_verified: true, firebase: { sign_in_provider: 'google.com' }, ...over,
  }).firestore()
  const profile = (email) => ({ name: 'Dan', email, createdAt: serverTimestamp(), lastSeen: serverTimestamp() })

  it('accounts on the allowed domain can read and register', async () => {
    const fs = as('dan', 'dan@allowed.test')
    await assertSucceeds(getDoc(doc(fs, 'items/item1')))
    await assertSucceeds(setDoc(doc(fs, 'users/dan'), profile('dan@allowed.test')))
  })
  it('the domain match ignores case', () =>
    assertSucceeds(getDoc(doc(as('dan', 'Dan@ALLOWED.TEST'), 'settings/auction'))))
  it('other domains get no access at all', async () => {
    for (const email of ['dan@gmail.com', 'dan@notallowed.test', 'dan@allowed.test.evil.com', 'dan@allowed-test']) {
      const fs = as('dan', email)
      await assertFails(getDoc(doc(fs, 'items/item1')))
      await assertFails(getDoc(doc(fs, 'settings/auction')))
      await assertFails(setDoc(doc(fs, 'users/dan'), profile(email)))
    }
  })
  it('an unverified email on the allowed domain is refused', () =>
    assertFails(getDoc(doc(as('dan', 'dan@allowed.test', { email_verified: false }), 'items/item1'))))
  it('outsiders cannot bid even with a profile doc', async () => {
    await seed((fs) => setDoc(doc(fs, 'users/eve'), user('eve')))
    await assertFails(rawBid(as('eve', 'eve@gmail.com'), 'item1', { n: 1, amount: 5000, uid: 'eve' }))
  })
  it('emulator test accounts (@example.com) only work on demo-* projects', async () => {
    await assertSucceeds(getDoc(doc(as('dan', 'dan@allowed.test', { aud: 'real-project' }), 'items/item1')))
    await assertFails(getDoc(doc(as('dan', 'dan@example.com', { aud: 'real-project' }), 'items/item1')))
  })
})

describe('valid bids', () => {
  it('placeBid: first bid at the starting price', async () => {
    const fs = db('alice')
    await assertSucceeds(placeBid(fs, { itemId: 'item1', uid: 'alice', amount: 5000, settings: SETTINGS }))
    const item = (await getDoc(doc(fs, 'items/item1'))).data()
    expect(item).toMatchObject({ currentAmount: 5000, bidCount: 1, highBidderUid: 'alice' })
  })
  it('placeBid: second bid at exactly the min increment', async () => {
    await placeBid(db('alice'), { itemId: 'item1', uid: 'alice', amount: 5000, settings: SETTINGS })
    await assertSucceeds(placeBid(db('bob'), { itemId: 'item1', uid: 'bob', amount: 5050, settings: SETTINGS }))
  })
  it('per-item increments override the global ones', async () => {
    await rawBid(db('alice'), 'item2', { n: 1, amount: 5000, uid: 'alice' })
    await assertFails(rawBid(db('bob'), 'item2', { n: 2, amount: 5100, uid: 'bob' }))
    await assertSucceeds(rawBid(db('bob'), 'item2', { n: 2, amount: 7000, uid: 'bob' }))
  })
})

describe('invalid bids are rejected by the rules', () => {
  it('below the starting price', () =>
    assertFails(rawBid(db('alice'), 'item1', { n: 1, amount: 4999, uid: 'alice' })))
  it('below the min increment', async () => {
    await rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice' })
    await assertFails(rawBid(db('bob'), 'item1', { n: 2, amount: 5049, uid: 'bob' }))
  })
  it('above the max increment', () =>
    assertFails(rawBid(db('alice'), 'item1', { n: 1, amount: 6001, uid: 'alice' })))
  it('non-integer amount', () =>
    assertFails(rawBid(db('alice'), 'item1', { n: 1, amount: 5000.5, uid: 'alice' })))
  it('skipping a bid number', () =>
    assertFails(rawBid(db('alice'), 'item1', { n: 2, amount: 5000, uid: 'alice' })))
  it('impersonating another bidder on the item', () =>
    assertFails(rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice', itemUid: 'bob' })))
  it('impersonating another bidder on the bid doc', () =>
    assertFails(rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'bob', itemUid: 'alice' })))
  it('bid doc amount differs from item amount', () =>
    assertFails(rawBid(db('alice'), 'item1', { n: 1, amount: 5000, bidAmount: 9999, uid: 'alice' })))
  it('item update without a bid doc', () =>
    assertFails(rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice', skipBidDoc: true })))
  it('bid doc without an item update', () =>
    assertFails(rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice', skipItem: true })))
  it('changing other item fields in the same write', () =>
    assertFails(rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice', extra: { title: 'x' } })))
  it('client-supplied lastBidAt instead of server time', () =>
    assertFails(rawBid(db('alice'), 'item1', {
      n: 1, amount: 5000, uid: 'alice', lastBidAt: Timestamp.fromMillis(Date.now() + HOUR),
    })))
  it('when bidding is closed', async () => {
    await seed((fs) => updateDoc(doc(fs, 'settings/auction'), { biddingOpen: false }))
    await assertFails(rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice' }))
  })
  it('from a user without a profile doc', () =>
    assertFails(rawBid(db('carol'), 'item1', { n: 1, amount: 5000, uid: 'carol' })))
  it('from an anonymous (non-Google) account', () =>
    assertFails(rawBid(anonDb('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice' })))
  it('bidders cannot edit or delete bid docs', async () => {
    await rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice' })
    await assertFails(updateDoc(doc(db('alice'), 'items/item1/bids/1'), { amount: 1 }))
    await assertFails(deleteDoc(doc(db('alice'), 'items/item1/bids/1')))
  })
})

describe('start time', () => {
  const startAt = (ms) => seed((fs) => updateDoc(doc(fs, 'settings/auction'), { startTime: ms == null ? null : Timestamp.fromMillis(ms) }))

  it('rejects bids before the start time, by the server clock', async () => {
    await startAt(Date.now() + HOUR)
    await assertFails(rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice' }))
  })
  it('accepts bids once the start time has passed', async () => {
    await startAt(Date.now() - 1000)
    await assertSucceeds(rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice' }))
  })
  it('a cleared (null) start time imposes nothing', async () => {
    await startAt(null)
    await assertSucceeds(rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice' }))
  })
  it('a page that has not heard of the start time yet is told bidding has not started', async () => {
    await startAt(Date.now() + HOUR)
    const bid = placeBid(db('alice'), { itemId: 'item1', uid: 'alice', amount: 5000, settings: SETTINGS })
    await expect(bid).rejects.toMatchObject({ code: 'not-started' })
    expect((await getDoc(doc(db('alice'), 'items/item1'))).data().bidCount).toBe(0)
  })
  it('bidders cannot move the start time', async () => {
    await assertFails(updateDoc(doc(db('alice'), 'settings/auction'), { startTime: null }))
  })
})

describe('end time and anti-sniping', () => {
  it('rejects bids after endTime when there was no late bid', async () => {
    await seed((fs) => updateDoc(doc(fs, 'items/item1'), { endTime: Timestamp.fromMillis(Date.now() - 1000) }))
    await assertFails(rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice' }))
  })
  it('allows bids after endTime within the window after the last bid', async () => {
    await seed((fs) => updateDoc(doc(fs, 'items/item1'), {
      endTime: Timestamp.fromMillis(Date.now() - 1000),
      lastBidAt: Timestamp.fromMillis(Date.now() - 30_000),
      bidCount: 1, currentAmount: 5000, highBidderUid: 'alice',
    }))
    await assertSucceeds(rawBid(db('bob'), 'item1', { n: 2, amount: 5050, uid: 'bob' }))
  })
  it('rejects bids once the anti-snipe window has passed', async () => {
    await seed((fs) => updateDoc(doc(fs, 'items/item1'), {
      endTime: Timestamp.fromMillis(Date.now() - 200_000),
      lastBidAt: Timestamp.fromMillis(Date.now() - 180_000),
      bidCount: 1, currentAmount: 5000, highBidderUid: 'alice',
    }))
    await assertFails(rawBid(db('bob'), 'item1', { n: 2, amount: 5050, uid: 'bob' }))
  })
})

describe('concurrency', () => {
  it('two simultaneous bids at the same amount: exactly one wins', async () => {
    const results = await Promise.allSettled([
      placeBid(db('alice'), { itemId: 'item1', uid: 'alice', amount: 5000, settings: SETTINGS }),
      placeBid(db('bob'), { itemId: 'item1', uid: 'bob', amount: 5000, settings: SETTINGS }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const item = (await getDoc(doc(db('alice'), 'items/item1'))).data()
    expect(item.bidCount).toBe(1)
  })

  it('the loser of a race is told they were outbid, not that the amount is too low', async () => {
    const bid = (uid) => placeBid(db(uid), { itemId: 'item1', uid, amount: 5000, settings: SETTINGS, seenBidCount: 0 })
    const results = await Promise.allSettled([bid('alice'), bid('bob')])
    const lost = results.find((r) => r.status === 'rejected')
    expect(lost.reason).toMatchObject({ code: 'outbid' })
    expect(lost.reason.message).toMatch(/^Someone else bid first\. The price is now Rs\. 5,000; the minimum bid is Rs\. 5,050\.$/)
  })

  it('a bid on a price that moved since the bidder looked is reported as outbid', async () => {
    await placeBid(db('bob'), { itemId: 'item1', uid: 'bob', amount: 5000, settings: SETTINGS })
    const stale = { itemId: 'item1', uid: 'alice', amount: 5000, settings: SETTINGS }
    await expect(placeBid(db('alice'), { ...stale, seenBidCount: 0 })).rejects.toMatchObject({ code: 'outbid' })
    // Without knowing what the bidder saw, it's still the plain minimum message.
    await expect(placeBid(db('alice'), stale)).rejects.toMatchObject({ code: 'too-low' })
  })

  it("the same bidder's own earlier bid winning is not reported as someone else", async () => {
    await placeBid(db('alice'), { itemId: 'item1', uid: 'alice', amount: 5000, settings: SETTINGS })
    const other = placeBid(db('alice'), { itemId: 'item1', uid: 'alice', amount: 5000, settings: SETTINGS, seenBidCount: 0 })
    await expect(other).rejects.toMatchObject({ code: 'outbid' })
    await expect(other).rejects.toThrow(/^You're already the highest bidder, at Rs\. 5,000\. The minimum to raise your bid is Rs\. 5,050\.$/)
  })

  it('a bid the server refuses because the item just closed says so', async () => {
    const end = Date.now() - 500
    await seed((fs) => setDoc(doc(fs, 'items/item3'), baseItem({ endTime: Timestamp.fromMillis(end) })))
    // The client's clock estimate is 1.5 s behind, so its own check lets the bid through.
    const late = placeBid(db('alice'), { itemId: 'item3', uid: 'alice', amount: 5000, settings: SETTINGS, now: end - 1000 })
    await expect(late).rejects.toMatchObject({ code: 'ended', message: 'Bidding on this item has just closed.' })
    expect((await getDoc(doc(db('alice'), 'items/item3'))).data().bidCount).toBe(0)
  })

  it('a bid refused because bidding was just closed says so, even near the end', async () => {
    const end = Date.now() + 1000
    await seed(async (fs) => {
      await setDoc(doc(fs, 'items/item3'), baseItem({ endTime: Timestamp.fromMillis(end) }))
      await updateDoc(doc(fs, 'settings/auction'), { biddingOpen: false })
    })
    // The bidder's page hasn't heard about the pause yet: its settings still say open.
    const bid = placeBid(db('alice'), { itemId: 'item3', uid: 'alice', amount: 5000, settings: SETTINGS })
    await expect(bid).rejects.toMatchObject({ code: 'closed', message: 'Bidding is currently closed.' })
  })
})

describe('users', () => {
  const newUser = (over = {}) => ({
    name: 'Carol', email: 'carol@example.com',
    createdAt: serverTimestamp(), lastSeen: serverTimestamp(), ...over,
  })
  it('can create own profile', () =>
    assertSucceeds(setDoc(doc(db('carol'), 'users/carol'), newUser())))
  it('cannot add extra fields', () =>
    assertFails(setDoc(doc(db('carol'), 'users/carol'), newUser({ admin: true }))))
  it('email must match the token', () =>
    assertFails(setDoc(doc(db('carol'), 'users/carol'), newUser({ email: 'x@example.com' }))))
  it('cannot create a profile for someone else', () =>
    assertFails(setDoc(doc(db('carol'), 'users/dave'), newUser())))
  it('can touch own lastSeen only', async () => {
    const fs = db('alice')
    await assertFails(updateDoc(doc(fs, 'users/alice'), { name: 'Bob', lastSeen: serverTimestamp() }))
    await assertFails(updateDoc(doc(fs, 'users/alice'), { email: 'z@example.com', lastSeen: serverTimestamp() }))
    await assertFails(updateDoc(doc(fs, 'users/alice'), { lastSeen: Timestamp.now() }))
    await assertSucceeds(updateDoc(doc(fs, 'users/alice'), { lastSeen: serverTimestamp() }))
  })
  it('cannot touch lastSeen again within a minute (write spam)', async () => {
    const fs = db('alice')
    await assertSucceeds(updateDoc(doc(fs, 'users/alice'), { lastSeen: serverTimestamp() }))
    await assertFails(updateDoc(doc(fs, 'users/alice'), { lastSeen: serverTimestamp() }))
  })
  it("cannot touch someone else's lastSeen", () =>
    assertFails(updateDoc(doc(db('alice'), 'users/bob'), { lastSeen: serverTimestamp() })))
  it('cannot read other users; admin can', async () => {
    await assertFails(getDoc(doc(db('alice'), 'users/bob')))
    await assertSucceeds(getDoc(doc(db('admin'), 'users/bob')))
  })
})

describe('admin', () => {
  it('nobody can write admins from the client', async () => {
    await assertFails(setDoc(doc(db('alice'), 'admins/alice'), {}))
    await assertFails(setDoc(doc(db('admin'), 'admins/alice'), {}))
  })
  it('only admins create items and change settings', async () => {
    await assertFails(setDoc(doc(db('alice'), 'items/item9'), baseItem()))
    await assertFails(updateDoc(doc(db('alice'), 'settings/auction'), { biddingOpen: false }))
    await assertSucceeds(setDoc(doc(db('admin'), 'items/item9'), baseItem()))
    await assertSucceeds(updateDoc(doc(db('admin'), 'settings/auction'), { biddingOpen: false }))
  })
  it('admins can reset bids, but only while bidding is paused', async () => {
    await rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice' })
    await assertFails(deleteDoc(doc(db('admin'), 'items/item1/bids/1')))
    await updateDoc(doc(db('admin'), 'settings/auction'), { biddingOpen: false })
    await assertSucceeds(deleteDoc(doc(db('admin'), 'items/item1/bids/1')))
  })
})

describe('bid history visibility', () => {
  beforeEach(async () => {
    await rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice' })
    await rawBid(db('bob'), 'item1', { n: 2, amount: 5050, uid: 'bob' })
  })
  it('users can query their own bids', async () => {
    const fs = db('alice')
    const snap = await assertSucceeds(getDocs(query(collectionGroup(fs, 'bids'), where('uid', '==', 'alice'))))
    expect(snap.size).toBe(1)
  })
  it('users cannot list all bids or read others', async () => {
    await assertFails(getDocs(collectionGroup(db('alice'), 'bids')))
    await assertFails(getDoc(doc(db('alice'), 'items/item1/bids/2')))
  })
  it('admins can list all bids', () =>
    assertSucceeds(getDocs(collectionGroup(db('admin'), 'bids'))))
})

describe('raised minimum increment (settings.escalation)', () => {
  // item1: starting price 5000, increments 50..1000 (settings). Over 25% = above 6250.
  // item2: its own increments 500..2000.
  const ESC = { enabled: true, percent: 25, factor: 2 }
  const setEsc = (escalation) => seed((fs) => updateDoc(doc(fs, 'settings/auction'), { escalation }))
  const atPrice = (itemId, currentAmount, over = {}) =>
    seed((fs) => updateDoc(doc(fs, 'items', itemId), { currentAmount, bidCount: 3, highBidderUid: 'alice', ...over }))
  const bidAt = (itemId, amount) => rawBid(db('bob'), itemId, { n: 4, amount, uid: 'bob' })
  const undoBid = (itemId, price, over) => Promise.all([
    atPrice(itemId, price, over),
    seed((fs) => deleteDoc(doc(fs, 'items', itemId, 'bids', '4'))),
  ])

  it('nothing changes while it is off or absent', async () => {
    await atPrice('item1', 7000)
    await assertSucceeds(bidAt('item1', 7050))
    await undoBid('item1', 7000)
    await setEsc({ ...ESC, enabled: false })
    await assertSucceeds(bidAt('item1', 7050))
  })

  it('at exactly the threshold the normal increment applies; one above it, the doubled one', async () => {
    await setEsc(ESC)
    await atPrice('item1', 6250)
    await assertSucceeds(bidAt('item1', 6300))
    await undoBid('item1', 6251)
    await assertFails(bidAt('item1', 6350))
    await assertSucceeds(bidAt('item1', 6351))
  })

  it('placeBid with the raised minimum goes through; the client refuses less before writing', async () => {
    await setEsc(ESC)
    await atPrice('item1', 7000)
    const settings = { ...SETTINGS, escalation: ESC }
    await expect(placeBid(db('bob'), { itemId: 'item1', uid: 'bob', amount: 7099, settings }))
      .rejects.toMatchObject({ code: 'too-low', message: 'Minimum bid is Rs. 7,100.' })
    await assertSucceeds(placeBid(db('bob'), { itemId: 'item1', uid: 'bob', amount: 7100, settings }))
  })

  it("switched on while a bidder's page still has the old settings: refused, then told the new minimum", async () => {
    await atPrice('item1', 7000)
    await setEsc(ESC) // the page hasn't heard yet: it passes SETTINGS without escalation
    await expect(placeBid(db('bob'), { itemId: 'item1', uid: 'bob', amount: 7050, settings: SETTINGS, seenBidCount: 3 }))
      .rejects.toMatchObject({ code: 'too-low', message: 'Minimum bid is Rs. 7,100.' })
    const item = (await getDoc(doc(db('bob'), 'items/item1'))).data()
    expect(item).toMatchObject({ currentAmount: 7000, bidCount: 3, highBidderUid: 'alice' })
  })

  it('switched off while a page still shows the raised minimum: a bid at that minimum is still valid', async () => {
    await atPrice('item1', 7000)
    await assertSucceeds(placeBid(db('bob'), { itemId: 'item1', uid: 'bob', amount: 7100, settings: { ...SETTINGS, escalation: ESC } }))
  })

  it('the maximum increment still applies', async () => {
    await setEsc(ESC)
    await atPrice('item1', 7000)
    await assertFails(bidAt('item1', 8001))
    await assertSucceeds(bidAt('item1', 8000))
  })

  it('a malformed setting (edited by hand) raises nothing, and bidding carries on', async () => {
    await atPrice('item1', 7000)
    const bad = [
      { ...ESC, enabled: 'true' }, { ...ESC, percent: '25' }, { ...ESC, factor: '2' },
      { ...ESC, factor: 0 }, { ...ESC, percent: -5 }, { ...ESC, factor: 101 }, { ...ESC, percent: 10001 },
      { ...ESC, factor: Infinity }, { ...ESC, factor: NaN }, 'on', { enabled: true }, null,
    ]
    for (const escalation of bad) {
      await setEsc(escalation)
      await assertSucceeds(bidAt('item1', 7050))
      await undoBid('item1', 7000)
    }
  })

  it('an item without a starting price is never raised', async () => {
    await setEsc(ESC)
    await seed((fs) => updateDoc(doc(fs, 'items/item1'), { startingPrice: deleteField(), currentAmount: 9000, bidCount: 3 }))
    await assertSucceeds(bidAt('item1', 9050))
  })

  it('bidders cannot switch it or change its values', async () => {
    await assertFails(updateDoc(doc(db('alice'), 'settings/auction'), { escalation: { ...ESC, enabled: false } }))
    await assertFails(setEscalation(db('alice'), ESC))
  })

  it('admins set it through setEscalation, merged into the settings', async () => {
    await assertSucceeds(setEscalation(db('admin'), { enabled: true, percent: 30, factor: 3 }))
    const s = (await getDoc(doc(db('alice'), 'settings/auction'))).data()
    expect(s).toEqual({ ...SETTINGS, escalation: { enabled: true, percent: 30, factor: 3 } })
  })

  // The client mirror must agree with the rules at every boundary: for each case
  // the client's minimum is accepted and one less refused, its maximum accepted
  // and one more refused.
  const PARITY = [
    ['absent', 'item1', 6300, {}, undefined],
    ['off', 'item1', 7000, {}, { ...ESC, enabled: false }],
    ['exactly at the threshold', 'item1', 6250, {}, ESC],
    ['just over it', 'item1', 6251, {}, ESC],
    ['admin values: over 10%, x3', 'item1', 5501, {}, { enabled: true, percent: 10, factor: 3 }],
    ['admin values: exactly 10%', 'item1', 5500, {}, { enabled: true, percent: 10, factor: 3 }],
    ['x10, under the max increment', 'item1', 7000, {}, { ...ESC, factor: 10 }],
    ['x30, held at the max increment', 'item1', 7000, {}, { ...ESC, factor: 30 }],
    ['per-item increments, doubled', 'item2', 7000, {}, ESC],
    ['per-item increments, held at the item max', 'item2', 7000, {}, { ...ESC, factor: 5 }],
    ['fractional factor from the console', 'item1', 7000, { minIncrement: 75 }, { ...ESC, factor: 1.5 }],
    ['percent 0 from the console', 'item1', 5001, {}, { ...ESC, percent: 0 }],
    ['malformed', 'item1', 7000, {}, { ...ESC, factor: '2' }],
    ['factor at its upper bound, held at the max', 'item1', 7000, {}, { ...ESC, factor: 100 }],
    ['factor over its upper bound', 'item1', 7000, {}, { ...ESC, factor: 101 }],
    ['infinite factor', 'item1', 7000, {}, { ...ESC, factor: Infinity }],
  ]
  for (const [label, itemId, price, itemOver, escalation] of PARITY) {
    it(`rules and client agree: ${label}`, async () => {
      if (escalation !== undefined) await setEsc(escalation)
      await atPrice(itemId, price, itemOver)
      let item, settings
      await seed(async (fs) => {
        item = (await getDoc(doc(fs, 'items', itemId))).data()
        settings = (await getDoc(doc(fs, 'settings/auction'))).data()
      })
      const min = minNextBid(item, settings)
      const max = maxNextBid(item, settings)
      expect(Number.isInteger(min)).toBe(true)
      await assertFails(bidAt(itemId, min - 1))
      await assertFails(bidAt(itemId, max + 1))
      await assertSucceeds(bidAt(itemId, min))
      await undoBid(itemId, price, itemOver)
      await assertSucceeds(bidAt(itemId, max))
    })
  }
})
