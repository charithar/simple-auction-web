#!/usr/bin/env node
// Load test against the RUNNING local emulators (npm run emulators[:docker], then npm run seed).
// Simulates N bidders placing bids through placeBid() with the real rules, and counts
// the document reads their listeners receive, which is what Firestore bills.
//
//   npm run load                                  # 100 bidders, 60 s, the app's real strategy
//   npm run load -- --mode all                    # old strategy: every client listens to all items
//   npm run load -- --users 50 --duration 120 --gap 8 --screen 6
//
// --mode visible (default, = the app): each bidder reads the catalog doc once and keeps
//   live listeners only on the items "on screen" (--screen consecutive lots, scrolling
//   every 15-30 s), its favourites (the items it bids on) and items it has bid on.
// --mode all: each bidder listens to the whole items collection.
import { parseArgs } from 'node:util'
import { initializeApp, deleteApp } from 'firebase/app'
import { getAuth, connectAuthEmulator, GoogleAuthProvider, signInWithCredential } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator, setLogLevel } from 'firebase/firestore'
import { syncProfile } from '../src/lib/profile.js'
import { subscribeItems, subscribeItem, subscribeCatalog, subscribeSettings, subscribeMyBidItems } from '../src/lib/items.js'
import { placeBid } from '../src/lib/bids.js'
import { minNextBid, increments } from '../src/lib/auction.js'

const { values: args } = parseArgs({
  options: {
    users: { type: 'string', default: '100' },
    duration: { type: 'string', default: '60' }, // seconds of bidding
    gap: { type: 'string', default: '10' }, // mean seconds between a bidder's bids
    mode: { type: 'string', default: 'visible' },
    screen: { type: 'string', default: '6' }, // cards on screen (phone ≈ 4-6, desktop ≈ 12)
  },
})
const N = Number(args.users)
const DURATION = Number(args.duration) * 1000
const GAP = Number(args.gap) * 1000
const MODE = args.mode
const SCREEN = Number(args.screen)
setLogLevel('silent')

const reads = { initial: 0, fanout: 0, scroll: 0, settings: 0, transactions: 0 }
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

  const b = { i, app, db, uid: user.uid, ids: [], live: new Map(), settings: null, unsubs: [], watched: new Map() }
  b.unsubs.push(subscribeSettings(db, (s) => { b.settings = s; reads.settings++ }, console.error))

  if (MODE === 'all') {
    await new Promise((resolve) => {
      let first = true
      b.unsubs.push(subscribeItems(db, (list) => {
        b.ids = list.map((it) => it.id)
        for (const it of list) b.live.set(it.id, it)
        if (first) { first = false; resolve() }
      }, console.error, (changes) => {
        if (b.ids.length === 0) reads.initial += changes
        else if (bidding) reads.fanout += changes
      }))
    })
  } else {
    await new Promise((resolve) => {
      b.unsubs.push(subscribeCatalog(db, (list) => {
        reads.initial++
        b.ids = (list ?? []).map((e) => e.id)
        resolve()
      }, console.error))
    })
    b.screenStart = Math.floor(Math.random() ** 2 * Math.max(1, b.ids.length - SCREEN))
    for (const id of b.ids.slice(b.screenStart, b.screenStart + SCREEN)) watch(b, id)
  }
  b.unsubs.push(subscribeMyBidItems(db, b.uid, (ids) => { if (MODE !== 'all') for (const id of ids) watch(b, id) }, console.error))

  // Each bidder is interested in a few items, skewed toward the first lots.
  b.favorites = Array.from({ length: 3 }, () => b.ids[Math.floor(Math.random() ** 2 * b.ids.length)])
  if (MODE !== 'all') for (const id of b.favorites) watch(b, id)
  return b
}

// Per-item listener (visible mode). First snapshot = 1 read, later ones = fan-out.
function watch(b, id, onScroll = false) {
  if (b.watched.has(id)) return
  let first = true
  b.watched.set(id, subscribeItem(b.db, id, (doc) => {
    if (doc) b.live.set(id, doc)
    if (first) {
      first = false
      if (onScroll) reads.scroll++
      else reads.initial++
    } else if (bidding) reads.fanout++
  }, console.error))
}

function unwatch(b, id) {
  b.watched.get(id)?.()
  b.watched.delete(id)
  b.live.delete(id)
}

// Simulated scrolling: move the on-screen window every 15-30 s.
async function scrollLoop(b, until) {
  if (MODE === 'all') return
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 15_000 + Math.random() * 15_000))
    const old = new Set(b.ids.slice(b.screenStart, b.screenStart + SCREEN))
    b.screenStart = Math.max(0, Math.min(b.ids.length - SCREEN, b.screenStart + Math.round((Math.random() - 0.3) * 8)))
    const now = new Set(b.ids.slice(b.screenStart, b.screenStart + SCREEN))
    const keep = new Set([...b.favorites])
    for (const id of old) if (!now.has(id) && !keep.has(id)) unwatch(b, id)
    for (const id of now) watch(b, id, true)
  }
}

async function bidLoop(b, until) {
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, GAP * (0.5 + Math.random())))
    if (Date.now() >= until) break
    const item = b.live.get(b.favorites[Math.floor(Math.random() * b.favorites.length)])
    if (!item || !b.settings) continue
    // Mostly the suggested minimum (from possibly stale local data), sometimes a step more.
    const amount = minNextBid(item, b.settings) + (Math.random() < 0.3 ? increments(item, b.settings).min : 0)
    const t0 = performance.now()
    reads.transactions++
    const concurrent = inFlight.get(item.id) ?? 0
    inFlight.set(item.id, concurrent + 1)
    try {
      await placeBid(b.db, { itemId: item.id, uid: b.uid, amount, settings: b.settings })
      count('accepted')
    } catch (e) {
      if (e.code === 'outbid') reads.transactions++ // placeBid re-reads once
      count(e.code ?? 'error')
      if (e.code === 'permission-denied') {
        // Was another bid on this item in flight at the same time?
        count(concurrent > 0 || (inFlight.get(item.id) ?? 1) > 1 ? 'denied-while-overlapping' : 'denied-ALONE')
      }
      if (process.env.LOAD_DEBUG && e.code === 'permission-denied' && (outcomes.get('permission-denied') ?? 0) <= 3) {
        const { getDocFromServer, doc: d } = await import('firebase/firestore')
        const fresh = (await getDocFromServer(d(b.db, 'items', item.id))).data()
        const next = await getDocFromServer(d(b.db, 'items', item.id, 'bids', String(fresh.bidCount + 1))).catch((x) => x.code)
        console.log('DEBUG denied', JSON.stringify({
          amount, local: { bidCount: item.bidCount, currentAmount: item.currentAmount },
          fresh: { bidCount: fresh.bidCount, currentAmount: fresh.currentAmount, high: fresh.highBidderUid === b.uid ? 'me' : 'other' },
          nextBidDoc: typeof next === 'string' ? next : next.exists() ? next.data() : 'none',
          msg: e.message.slice(0, 300),
        }))
      }
    } finally {
      latencies.push(performance.now() - t0)
      inFlight.set(item.id, inFlight.get(item.id) - 1)
    }
  }
}

// ---- run ----
console.log(`Signing in ${N} bidders (mode: ${MODE}${MODE === 'visible' ? `, ${SCREEN} cards on screen` : ''})…`)
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
const loadReads = reads.initial
console.log(`${N} bidders, ${items} items. Bidding for ${DURATION / 1000}s (mean gap ${GAP / 1000}s)…`)

bidding = true
const until = Date.now() + DURATION
await Promise.all(bidders.flatMap((b) => [bidLoop(b, until), scrollLoop(b, until)]))
await new Promise((r) => setTimeout(r, 2000)) // let final snapshots arrive
bidding = false

const accepted = outcomes.get('accepted') ?? 0
const attempted = [...outcomes.values()].reduce((a, b) => a + b, 0)
const sorted = [...latencies].sort((a, b) => a - b)
const pct = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0)
const rulesReads = accepted * 3 // settings get + users exists + cross-checks (upper-bound estimate)
const total = reads.initial + reads.fanout + reads.scroll + reads.settings + reads.transactions + rulesReads
const fanPerBid = reads.fanout / Math.max(accepted, 1)
const loadPer = loadReads / N

console.log(`
Bids:        ${attempted} attempted, ${accepted} accepted
Outcomes:    ${[...outcomes].map(([k, v]) => `${k} ${v}`).join(', ')}
Latency:     p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms (emulator; grows with listener count)

Reads (what Firestore would bill):
  page loads              ${reads.initial}   (${loadPer.toFixed(1)} per bidder)
  scrolling               ${reads.scroll}
  bid fan-out             ${reads.fanout}   (${fanPerBid.toFixed(1)} per accepted bid, ${N} bidders online)
  settings snapshots      ${reads.settings}
  bid transactions        ${reads.transactions}
  rules lookups (est.)    ${rulesReads}
  total                   ${total}   (${((total / 50_000) * 100).toFixed(1)}% of the 50k/day free quota)
Writes:      ${accepted * 2 + N} of 20k/day
`)

// Fan-out scales with how many people are online; measured here with N.
console.log(`Projection (fan-out scaled from ${N} online to the average online):`)
for (const [loads, bids] of [[400, 600], [400, 1000], [600, 1500]]) {
  for (const online of [30, 60, 100]) {
    const est = Math.round(loads * loadPer + bids * (fanPerBid * (online / N) + 4))
    console.log(`  ${String(loads).padStart(3)} page loads, ${String(bids).padStart(4)} bids, ${String(online).padStart(3)} online on average → ${String(est).padStart(6)} reads ${est > 50_000 ? '⚠ over quota' : ''}`)
  }
}

for (const b of bidders) {
  b.unsubs.forEach((u) => u())
  b.watched.forEach((u) => u())
}
await Promise.all(bidders.map((b) => deleteApp(b.app)))
process.exit(0)
