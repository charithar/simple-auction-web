#!/usr/bin/env node
// Load test against the RUNNING local emulators (npm run emulators[:docker], then npm run seed).
// Simulates N bidders placing bids through placeBid() with the real rules, and counts
// the document reads their listeners receive, which is what Firestore bills. Each
// bidder listens like the app does: settings, all items and its own bids.
//
//   npm run load                                  # 100 bidders, 60 s
//   npm run load -- --users 50 --duration 120 --gap 8 --price 0.06
//
// --price: USD per 100,000 reads beyond the free 50k/day, for the cost estimate
// (check the Firestore pricing page for your database's location).
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
    price: { type: 'string', default: '0.06' },
  },
})
const N = Number(args.users)
const DURATION = Number(args.duration) * 1000
const GAP = Number(args.gap) * 1000
const PRICE = Number(args.price)
const FREE_READS = 50_000
setLogLevel('silent')

const reads = { initial: 0, fanout: 0, settings: 0, transactions: 0 }
const outcomes = new Map()
const latencies = []
const inFlight = new Map() // itemId -> bids currently being placed
const count = (k) => outcomes.set(k, (outcomes.get(k) ?? 0) + 1)
let bidding = false

async function makeBidder(i) {
  const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-auction' }, `load-${i}-${Date.now()}`)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const db = getFirestore(app)
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  const idToken = JSON.stringify({ sub: `load-${i}`, email: `load${i}@example.com`, email_verified: true, name: `Load Bidder ${i}` })
  const { user } = await signInWithCredential(auth, GoogleAuthProvider.credential(idToken))
  await syncProfile(db, user)

  const b = { i, app, db, uid: user.uid, ids: [], items: new Map(), settings: null, unsubs: [] }
  b.unsubs.push(subscribeSettings(db, (s) => { b.settings = s; reads.settings++ }, console.error))
  await new Promise((resolve) => {
    let first = true
    b.unsubs.push(subscribeItems(db, (list) => {
      b.ids = list.map((it) => it.id)
      for (const it of list) b.items.set(it.id, it)
      if (first) { first = false; resolve() }
    }, console.error, (changes) => {
      if (bidding) reads.fanout += changes
      else reads.initial += changes
    }))
  })
  b.unsubs.push(subscribeMyBidItems(db, b.uid, () => {}, console.error))

  // Each bidder is interested in a few items, skewed toward the first lots.
  b.favorites = Array.from({ length: 3 }, () => b.ids[Math.floor(Math.random() ** 2 * b.ids.length)])
  return b
}

async function bidLoop(b, until) {
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, GAP * (0.5 + Math.random())))
    if (Date.now() >= until) break
    const item = b.items.get(b.favorites[Math.floor(Math.random() * b.favorites.length)])
    if (!item || !b.settings) continue
    // Mostly the suggested minimum (from possibly stale local data), sometimes a step more.
    const amount = minNextBid(item, b.settings) + (Math.random() < 0.3 ? increments(item, b.settings).min : 0)
    const t0 = performance.now()
    reads.transactions++
    const concurrent = inFlight.get(item.id) ?? 0
    inFlight.set(item.id, concurrent + 1)
    try {
      // As BidDialog calls it: the bid count the bidder saw, and the current time.
      await placeBid(b.db, { itemId: item.id, uid: b.uid, amount, settings: b.settings, seenBidCount: item.bidCount })
      count('accepted')
    } catch (e) {
      if (e.code === 'outbid') reads.transactions++ // placeBid may re-read once
      count(e.code ?? 'error')
      if (e.code === 'permission-denied') {
        // Was another bid on this item in flight at the same time?
        count(concurrent > 0 || (inFlight.get(item.id) ?? 1) > 1 ? 'denied-while-overlapping' : 'denied-ALONE')
      }
    } finally {
      latencies.push(performance.now() - t0)
      inFlight.set(item.id, inFlight.get(item.id) - 1)
    }
  }
}

// ---- run ----
console.log(`Signing in ${N} bidders…`)
const bidders = []
for (let i = 0; i < N; i += 20) {
  bidders.push(...(await Promise.all(Array.from({ length: Math.min(20, N - i) }, (_, k) => makeBidder(i + k)))))
}
await new Promise((r) => setTimeout(r, 1500)) // initial snapshots
if (!bidders[0].settings?.biddingOpen) {
  console.error('Bidding is closed. Run: npm run seed')
  process.exit(1)
}
const items = bidders[0].ids.length
console.log(`${N} bidders, ${items} items. Bidding for ${DURATION / 1000}s (mean gap ${GAP / 1000}s)…`)

bidding = true
const until = Date.now() + DURATION
await Promise.all(bidders.map((b) => bidLoop(b, until)))
await new Promise((r) => setTimeout(r, 2000)) // let final snapshots arrive
bidding = false

const accepted = outcomes.get('accepted') ?? 0
const attempted = [...outcomes.values()].reduce((a, b) => a + b, 0)
const sorted = [...latencies].sort((a, b) => a - b)
const pct = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0)
const rulesReads = accepted * 3 // settings get + users exists + cross-checks (upper-bound estimate)
const total = reads.initial + reads.fanout + reads.settings + reads.transactions + rulesReads
const fanPerBid = reads.fanout / Math.max(accepted, 1)
const loadPer = reads.initial / N
const cost = (r) => (Math.max(0, r - FREE_READS) / 100_000) * PRICE

console.log(`
Bids:        ${attempted} attempted, ${accepted} accepted
Outcomes:    ${[...outcomes].map(([k, v]) => `${k} ${v}`).join(', ')}
Latency:     p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms (emulator; grows with listener count)

Reads (what Firestore would bill):
  page loads              ${reads.initial}   (${loadPer.toFixed(1)} per bidder)
  bid fan-out             ${reads.fanout}   (${fanPerBid.toFixed(1)} per accepted bid, ${N} bidders online)
  settings snapshots      ${reads.settings}
  bid transactions        ${reads.transactions}
  rules lookups (est.)    ${rulesReads}
  total                   ${total}
Writes:      ${accepted * 2 + N}
`)

// Fan-out scales with how many people are online; measured here with N.
console.log(`Projection for a day (fan-out scaled from ${N} online; cost beyond the free ${FREE_READS / 1000}k reads at $${PRICE}/100k):`)
for (const [loads, bids] of [[400, 600], [400, 1000], [600, 1500]]) {
  for (const online of [30, 60, 100]) {
    const est = Math.round(loads * loadPer + bids * (fanPerBid * (online / N) + 4))
    console.log(`  ${String(loads).padStart(3)} page loads, ${String(bids).padStart(4)} bids, ${String(online).padStart(3)} online → ${String(est).padStart(6)} reads, ~$${cost(est).toFixed(3)}`)
  }
}

for (const b of bidders) b.unsubs.forEach((u) => u())
await Promise.all(bidders.map((b) => deleteApp(b.app)))
process.exit(0)
