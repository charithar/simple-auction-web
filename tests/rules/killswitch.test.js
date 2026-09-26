// Emergency stop (settings/killswitch, firestore.rules live()): while the
// document exists only admins can read or write. Runs on the emulator.
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collectionGroup, query, where, Timestamp, serverTimestamp,
  setLogLevel,
} from 'firebase/firestore'
import { renderRules, RULES_TEMPLATE } from '../../scripts/build-rules.mjs'
import { placeBid } from '../../src/lib/bids.js'
import { syncProfile, checkAdmin } from '../../src/lib/profile.js'
import { setKillSwitch } from '../../src/lib/admin.js'

const SETTINGS = { biddingOpen: true, minIncrement: 50, maxIncrement: 1000, antiSnipeSeconds: 120 }
const HOUR = 3_600_000
let env

const db = (uid) => env.authenticatedContext(uid, {
  email: `${uid}@example.com`, email_verified: true, firebase: { sign_in_provider: 'google.com' },
}).firestore()
const seed = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()))
const user = (uid) => ({
  name: uid, email: `${uid}@example.com`,
  createdAt: Timestamp.fromMillis(Date.now() - HOUR), lastSeen: Timestamp.fromMillis(Date.now() - HOUR),
})
const item = () => ({
  title: 'Lot', currency: 'Rs.', startingPrice: 5000, currentAmount: 5000, bidCount: 0,
  highBidderUid: null, lastBidAt: null, endTime: Timestamp.fromMillis(Date.now() + HOUR),
})
const bid = (uid, amount) => placeBid(db(uid), { itemId: 'item1', uid, amount, settings: SETTINGS })
const myBids = (uid) => getDocs(query(collectionGroup(db(uid), 'bids'), where('uid', '==', uid)))

beforeAll(async () => {
  setLogLevel('silent')
  env = await initializeTestEnvironment({
    projectId: 'demo-auction',
    firestore: { rules: renderRules(readFileSync(RULES_TEMPLATE, 'utf8'), ['allowed.test']) },
  })
})

afterAll(() => env?.cleanup())

beforeEach(async () => {
  await env.clearFirestore()
  await seed(async (fs) => {
    await setDoc(doc(fs, 'settings/auction'), SETTINGS)
    await setDoc(doc(fs, 'items/item1'), item())
    for (const uid of ['alice', 'bob', 'admin']) await setDoc(doc(fs, 'users', uid), user(uid))
    await setDoc(doc(fs, 'admins/admin'), {})
  })
  await bid('alice', 5000) // alice has a bid before the stop
})

describe('emergency stop off (normal operation)', () => {
  it('bidders read and bid as usual', async () => {
    await assertSucceeds(getDoc(doc(db('bob'), 'items/item1')))
    await assertSucceeds(getDoc(doc(db('bob'), 'settings/auction')))
    expect((await myBids('alice')).size).toBe(1)
    await assertSucceeds(bid('bob', 5050))
  })
})

describe('emergency stop on', () => {
  beforeEach(() => setKillSwitch(db('admin'), true))

  it('bidders can read nothing: items, settings, their bids, their profile', async () => {
    await assertFails(getDoc(doc(db('bob'), 'items/item1')))
    await assertFails(getDoc(doc(db('bob'), 'settings/auction')))
    await assertFails(getDoc(doc(db('bob'), 'settings/killswitch')))
    await assertFails(myBids('alice'))
    await assertFails(getDoc(doc(db('bob'), 'users/bob')))
  })

  it('bidders can write nothing: no bids, no profile touch or creation', async () => {
    await expect(bid('bob', 5050)).rejects.toMatchObject({
      code: 'unavailable', message: 'The auction is temporarily unavailable. Please try again later.',
    })
    await assertFails(updateDoc(doc(db('bob'), 'users/bob'), { lastSeen: serverTimestamp() }))
    await assertFails(setDoc(doc(db('carol'), 'users/carol'), {
      name: 'carol', email: 'carol@example.com', createdAt: serverTimestamp(), lastSeen: serverTimestamp(),
    }))
    let item1
    await seed(async (fs) => (item1 = (await getDoc(doc(fs, 'items/item1'))).data()))
    expect(item1).toMatchObject({ bidCount: 1, highBidderUid: 'alice' }) // nothing got through
  })

  it('a bidder signing in is refused (the app then says the auction is unavailable)', async () => {
    await expect(syncProfile(db('bob'), { uid: 'bob', email: 'bob@example.com', displayName: 'Bob' }))
      .rejects.toMatchObject({ code: 'permission-denied' })
    expect(await checkAdmin(db('bob'), 'bob')).toBe(false)
  })

  it('bidders cannot turn it off', async () => {
    await assertFails(setKillSwitch(db('bob'), false))
  })

  it('admins keep full access: items, settings, profile sync, admin check, the switch itself', async () => {
    await assertSucceeds(getDoc(doc(db('admin'), 'items/item1')))
    await assertSucceeds(getDoc(doc(db('admin'), 'settings/killswitch')))
    const { profile } = await syncProfile(db('admin'), { uid: 'admin', email: 'admin@example.com', displayName: 'Admin' })
    expect(profile.name).toBe('admin')
    expect(await checkAdmin(db('admin'), 'admin')).toBe(true)
    await assertSucceeds(setKillSwitch(db('admin'), false))
  })

  it('turning it off restores everything', async () => {
    await setKillSwitch(db('admin'), false)
    await assertSucceeds(getDoc(doc(db('bob'), 'items/item1')))
    await assertSucceeds(bid('bob', 5050))
    expect((await myBids('alice')).size).toBe(1)
  })
})

describe('the switch is admin-only to set', () => {
  it('bidders cannot turn it on', async () => {
    await assertFails(setKillSwitch(db('bob'), true))
    await assertFails(deleteDoc(doc(db('bob'), 'settings/auction')))
  })
})
