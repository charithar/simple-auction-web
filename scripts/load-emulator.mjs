#!/usr/bin/env node
// Load test against the RUNNING local emulators (npm run emulators[:docker], then npm run seed).
// Simulates N bidders the way the real client behaves: each keeps live listeners on
// settings, items and its own bids, and places bids through placeBid() with the real rules.
// Counts the document reads each listener receives, which is what Firestore bills.
//
//   npm run load                                  # 100 bidders, 60 s
//   npm run load -- --users 50 --duration 120 --gap 8
import { parseArgs } from 'node:util'
import { initializeApp, deleteApp } from 'firebase/app'
import { getAuth, connectAuthEmulator, GoogleAuthProvider, signInWithCredential } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator, setLogLevel } from 'firebase/firestore'
import { syncProfile } from '../src/lib/profile.js'
import { subscribeItems, subscribeSettings, subscribeMyBidItems } from '../src/lib/items.js'
import { placeBid } from '../src/lib/bids.js'
import { minNextBid, increments } from '../src/lib/auction.js'

const { values: args } = parseArgs({
  options: {
    users: { type: 'string', default: '100' },
    duration: { type: 'string', default: '60' }, // seconds of bidding
    gap: { type: 'string', default: '10' }, // mean seconds between a bidder's bids
  },
})
const N = Number(args.users)
const DURATION = Number(args.duration) * 1000
const GAP = Number(args.gap) * 1000
setLogLevel('silent')

const reads = { initial: 0, fanout: 0, ownBids: 0, settings: 0, transactions: 0 }
const outcomes = new Map()
const latencies = []
const count = (k) => outcomes.set(k, (outcomes.get(k) ?? 0) + 1)

async function makeBidder(i) {
  const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-auction' }, `load-${i}-${Date.now()}`)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const db = getFirestore(app)
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  const idToken = JSON.stringify({ sub: `load-${i}`, email: `load${i}@example.com`, email_verified: true, name: `Load Bidder ${i}` })
  const { user } = await signInWithCredential(auth, GoogleAuthProvider.credential(idToken))
  await syncProfile(db, user)

  const b = { i, app, db, uid: user.uid, items: [], settings: null, unsubs: [], firstItems: true }
  await new Promise((resolve) => {
    b.unsubs.push(subscribeSettings(db, (s) => { b.settings = s; reads.settings++ }, console.error))
    // The real client uses subscribeItems too; count docChanges to mirror billing.
    b.unsubs.push(subscribeItemsCounting(db, b, resolve))
    b.unsubs.push(subscribeMyBidItems(db, b.uid, () => {}, console.error))
  })
  // Each bidder is interested in a few items, skewed toward the first lots.
  b.favorites = Array.from({ length: 3 }, () => b.items[Math.floor(Math.random() ** 2 * b.items.length)].id)
  return b
}

// Same query as subscribeItems, but counts the billed docs per snapshot.
function subscribeItemsCounting(db, b, onFirst) {
  let first = true
  return subscribeItems(db, (list) => {
    b.items = list
    if (first) {
      reads.initial += list.length
      first = false
      onFirst()
    }
  }, console.error, (changes) => {
    if (!b.firstItems) reads.fanout += changes
    b.firstItems = false
  })
}

async function bidLoop(b, until) {
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, GAP * (0.5 + Math.random())))
    if (Date.now() >= until) break
    const item = b.items.find((it) => it.id === b.favorites[Math.floor(Math.random() * b.favorites.length)])
    if (!item || !b.settings) continue
    // Mostly the suggested minimum (from possibly stale local data), sometimes a step more.
    const amount = minNextBid(item, b.settings) + (Math.random() < 0.3 ? increments(item, b.settings).min : 0)
    const t0 = performance.now()
    reads.transactions++
    try {
      await placeBid(b.db, { itemId: item.id, uid: b.uid, amount, settings: b.settings })
      count('accepted')
    } catch (e) {
      if (e.code === 'outbid') reads.transactions++ // placeBid re-reads once
      count(e.code ?? 'error')
    } finally {
      latencies.push(performance.now() - t0)
    }
  }
}

// ---- run ----
console.log(`Signing in ${N} bidders…`)
const bidders = []
for (let i = 0; i < N; i += 20) {
  bidders.push(...(await Promise.all(Array.from({ length: Math.min(20, N - i) }, (_, k) => makeBidder(i + k)))))
}
if (!bidders[0].settings?.biddingOpen) {
  console.error('Bidding is closed. Run: npm run seed')
  process.exit(1)
}
const items = bidders[0].items.length
console.log(`${N} bidders listening to ${items} items. Bidding for ${DURATION / 1000}s (mean gap ${GAP / 1000}s)…`)

const until = Date.now() + DURATION
await Promise.all(bidders.map((b) => bidLoop(b, until)))
await new Promise((r) => setTimeout(r, 2000)) // let final snapshots arrive

const accepted = outcomes.get('accepted') ?? 0
const attempted = [...outcomes.values()].reduce((a, b) => a + b, 0)
const sorted = [...latencies].sort((a, b) => a - b)
const pct = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0)
const rulesReads = accepted * 3 // settings get + users exists + item/bid cross-checks (upper-bound estimate)
const total = reads.initial + reads.fanout + reads.settings + reads.transactions + rulesReads

console.log(`
Bids:        ${attempted} attempted, ${accepted} accepted
Outcomes:    ${[...outcomes].map(([k, v]) => `${k} ${v}`).join(', ')}
Latency:     p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${Math.round(sorted.at(-1) ?? 0)} ms

Reads (what Firestore would bill):
  initial item loads      ${reads.initial}   (${N} × ${items})
  bid fan-out to listeners ${reads.fanout}   (${(reads.fanout / Math.max(accepted, 1)).toFixed(1)} per accepted bid ≈ listeners)
  settings snapshots      ${reads.settings}
  bid transactions        ${reads.transactions}
  rules lookups (est.)    ${rulesReads}
  total                   ${total}   (${((total / 50_000) * 100).toFixed(1)}% of the 50k/day free quota)
Writes:      ${accepted * 2 + N} (${accepted} bids × 2 + ${N} profile updates) of 20k/day
`)

const perBid = reads.fanout / Math.max(accepted, 1) + 1 + 3
console.log('Projection for a full day (fresh loads × items + bids × (listeners + ~4)):')
for (const loads of [200, 400]) {
  for (const bids of [300, 600, 1000]) {
    for (const listeners of [30, 60, 100]) {
      const est = loads * (items + 1) + bids * (listeners + 4)
      if (listeners === 60 || bids === 600) {
        console.log(`  ${String(loads).padStart(3)} fresh loads, ${String(bids).padStart(4)} bids, ${String(listeners).padStart(3)} avg listeners → ${String(est).padStart(6)} reads ${est > 50_000 ? '⚠ over quota' : ''}`)
      }
    }
  }
}
console.log(`  (measured fan-out here: ${perBid.toFixed(1)} reads per bid with ${N} listeners)`)

for (const b of bidders) b.unsubs.forEach((u) => u())
await Promise.all(bidders.map((b) => deleteApp(b.app)))
process.exit(0)
