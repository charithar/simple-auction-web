#!/usr/bin/env node
// End-to-end smoke test against the RUNNING local emulators (npm run emulators[:docker], then npm run seed).
// Signs in fake Google users through the Auth emulator and uses the app's own
// modules (syncProfile, subscribeItems, placeBid) with the real security rules.
//
//   npm run smoke
//   npm run smoke -- --users 20          # more concurrent bidders
import { parseArgs } from 'node:util'
import { initializeApp, deleteApp } from 'firebase/app'
import { getAuth, connectAuthEmulator, GoogleAuthProvider, signInWithCredential } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator, doc, getDoc, setLogLevel } from 'firebase/firestore'
import { syncProfile } from '../src/lib/profile.js'
import { subscribeItems, subscribeSettings, subscribeMyBidItems } from '../src/lib/items.js'
import { placeBid, bidErrorMessage } from '../src/lib/bids.js'
import { minNextBid } from '../src/lib/auction.js'

const { values: args } = parseArgs({ options: { users: { type: 'string', default: '5' } } })
const N = Number(args.users)
setLogLevel('silent')

let failures = 0
const check = (ok, msg) => {
  console.log(`${ok ? '✔' : '✘'} ${msg}`)
  if (!ok) failures++
}
const firstValue = (subscribe) =>
  new Promise((resolve, reject) => {
    const unsub = subscribe((v) => {
      unsub()
      resolve(v)
    }, reject)
  })

async function makeUser(i) {
  const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-auction' }, `smoke-${i}-${Date.now()}`)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const db = getFirestore(app)
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  const idToken = JSON.stringify({
    sub: `smoke-${i}`, email: `smoke${i}@example.com`, email_verified: true, name: `Smoke Bidder ${i}`,
  })
  const { user } = await signInWithCredential(auth, GoogleAuthProvider.credential(idToken))
  return { app, db, user }
}

const users = await Promise.all(Array.from({ length: N }, (_, i) => makeUser(i)))
check(users.every((u) => u.user.uid), `${N} Google users signed in via the Auth emulator`)

const profiles = await Promise.all(users.map((u) => syncProfile(u.db, u.user)))
check(profiles.every((p) => p.profile.name.startsWith('Smoke Bidder')), 'profiles synced')
check(profiles.every((p) => Math.abs(p.clockOffsetMs) < 2000), `clock offsets sane (${profiles.map((p) => Math.round(p.clockOffsetMs)).join(', ')} ms)`)

const [a] = users
const settings = await firstValue((ok, err) => subscribeSettings(a.db, ok, err))
check(settings?.biddingOpen === true, 'settings/auction readable and bidding open')
const items = await firstValue((ok, err) => subscribeItems(a.db, ok, err))
check(items.length > 0, `items listener returned ${items.length} items in lot order`)

// Everyone races for the same item at the same minimum amount: exactly one should win.
const target = items[0]
const amount = minNextBid(target, settings)
const results = await Promise.allSettled(
  users.map((u) => placeBid(u.db, { itemId: target.id, uid: u.user.uid, amount, settings })),
)
const winners = results.filter((r) => r.status === 'fulfilled').length
check(winners === 1, `${N} simultaneous bids of ${amount} on ${target.id}: ${winners} accepted`)
const losers = results.filter((r) => r.status === 'rejected').map((r) => r.reason)
check(
  losers.every((e) => ['too-low', 'outbid'].includes(e.code)),
  `losers get a specific reason (${[...new Set(losers.map((e) => e.code))].join(', ')})`,
)
if (losers.length) console.log(`  e.g. "${bidErrorMessage(losers.find((e) => e.code === 'outbid') ?? losers[0])}"`)

// Then everyone bids in sequence, each beating the last.
const fresh = (await getDoc(doc(a.db, 'items', target.id))).data()
let current = { ...fresh }
let sequentialOk = true
for (const u of users) {
  const next = minNextBid(current, settings)
  try {
    await placeBid(u.db, { itemId: target.id, uid: u.user.uid, amount: next, settings })
    current = { ...current, currentAmount: next, bidCount: current.bidCount + 1 }
  } catch (e) {
    sequentialOk = false
    console.log(`  ${u.user.uid}: ${bidErrorMessage(e)}`)
  }
}
const after = (await getDoc(doc(a.db, 'items', target.id))).data()
check(sequentialOk && after.bidCount === fresh.bidCount + N, `${N} sequential bids accepted (bidCount ${after.bidCount}, price ${after.currentAmount})`)
check(after.highBidderUid === users.at(-1).user.uid, 'last bidder is the high bidder')

const mine = await firstValue((ok, err) => subscribeMyBidItems(a.db, a.user.uid, ok, err))
check(mine.has(target.id), '"my bids" collection-group query sees own bid')

// A too-low bid is rejected client-side; a direct under-bid is rejected by rules (covered in rules tests).
try {
  await placeBid(a.db, { itemId: target.id, uid: a.user.uid, amount: after.currentAmount, settings })
  check(false, 'bid equal to current price rejected')
} catch (e) {
  check(e.code === 'too-low', `bid equal to current price rejected: "${bidErrorMessage(e)}"`)
}

await Promise.all(users.map((u) => deleteApp(u.app)))
console.log(failures ? `\n${failures} check(s) failed` : '\nAll smoke checks passed')
process.exit(failures ? 1 : 0)
