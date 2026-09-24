#!/usr/bin/env node
// Checks the LOCAL emulator for items whose bid docs don't match bidCount / currentAmount.
//   npm run check
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, getDocs, setLogLevel } from 'firebase/firestore'

setLogLevel('error')
const env = await initializeTestEnvironment({ projectId: 'demo-auction', firestore: { host: '127.0.0.1', port: 8080 } })
let problems = 0
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore()
  for (const it of (await getDocs(collection(db, 'items'))).docs) {
    const item = it.data()
    const bids = (await getDocs(collection(it.ref, 'bids'))).docs.map((d) => ({ n: Number(d.id), ...d.data() }))
    const ns = bids.map((b) => b.n).sort((a, b) => a - b)
    const top = bids.find((b) => b.n === item.bidCount)
    const ok = ns.length === item.bidCount && ns.every((n, i) => n === i + 1) &&
      (item.bidCount === 0 || (top?.amount === item.currentAmount && top?.uid === item.highBidderUid))
    if (!ok) {
      problems++
      console.log(`${it.id}: bidCount ${item.bidCount}, currentAmount ${item.currentAmount}, bid docs [${ns.join(',')}]` +
        (top ? `, top bid ${top.amount} by ${top.uid === item.highBidderUid ? 'high bidder' : 'someone else'}` : ''))
      for (const b of bids.filter((x) => x.n > item.bidCount)) {
        console.log(`   orphan #${b.n}: ${b.amount} at ${b.createdAt?.toDate().toISOString()}`)
      }
    }
  }
})
await env.cleanup()
console.log(problems ? `${problems} inconsistent item(s)` : 'All items consistent')
process.exit(problems ? 1 : 0)
