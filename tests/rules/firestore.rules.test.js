// Runs against the Firestore emulator: npm run test:rules (requires Java).
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing'
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, Timestamp, serverTimestamp,
  collectionGroup, query, where, getDocs, setLogLevel,
} from 'firebase/firestore'
import { placeBid } from '../../src/lib/bids.js'

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
  createdAt: Timestamp.now(), lastSeen: Timestamp.now(),
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
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
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
  it('can update own name and lastSeen only', async () => {
    const fs = db('alice')
    await assertSucceeds(updateDoc(doc(fs, 'users/alice'), { name: 'Al', lastSeen: serverTimestamp() }))
    await assertFails(updateDoc(doc(fs, 'users/alice'), { email: 'z@example.com', lastSeen: serverTimestamp() }))
  })
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
  it('admins can reset bids', async () => {
    await rawBid(db('alice'), 'item1', { n: 1, amount: 5000, uid: 'alice' })
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
