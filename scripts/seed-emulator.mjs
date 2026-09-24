#!/usr/bin/env node
// Seeds the LOCAL Firestore emulator from an auction file. Never touches a real project.
//
//   npm run seed                                   # data/auction.yml, first item closes in 30 min
//   npm run seed -- --first-close 5m               # first item closes in 5 minutes
//   npm run seed -- --admin you@example.com        # also make that emulator user an admin
//   npm run seed -- --closed                       # bidding switched off
//   npm run seed -- --admin-only you@example.com   # just grant admin; leave items and bids alone
//   npm run seed -- --file other.yml
//
// Existing items and bids are deleted; users and admins are kept.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, doc, getDocs, setDoc, setLogLevel, Timestamp, writeBatch } from 'firebase/firestore'
import { parseAuctionFile, shiftEndTimes, newItemDoc, parseDuration } from '../src/lib/importItems.js'
import { catalogRef, catalogDoc } from '../src/lib/catalog.js'

const PROJECT = 'demo-auction'
const FIRESTORE = { host: '127.0.0.1', port: 8080 }
const AUTH = 'http://127.0.0.1:9099'

const { values: args } = parseArgs({
  options: {
    file: { type: 'string', default: 'data/auction.yml' },
    'first-close': { type: 'string', default: '30m' },
    admin: { type: 'string' },
    closed: { type: 'boolean', default: false },
    'admin-only': { type: 'string' },
  },
})

if (args['admin-only']) {
  setLogLevel('error')
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: FIRESTORE })
  const uid = await uidForEmail(args['admin-only'])
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'admins', uid), {}))
  await env.cleanup()
  console.log(`Admin: ${args['admin-only']} (${uid})`)
  process.exit(0)
}

const { settings, items, errors } = parseAuctionFile(readFileSync(args.file, 'utf8'))
if (errors.length) {
  console.error(`Invalid ${args.file}:\n  ${errors.join('\n  ')}`)
  process.exit(1)
}
const offset = parseDuration(args['first-close'])
if (offset == null) {
  console.error('--first-close must look like 90s, 5m, 2h')
  process.exit(1)
}
const scheduled = shiftEndTimes(items, new Date(Date.now() + offset))

setLogLevel('error')
const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: FIRESTORE })

try {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()

    // Wipe items and their bids.
    const existing = await getDocs(collection(db, 'items'))
    for (const it of existing.docs) {
      const bids = await getDocs(collection(it.ref, 'bids'))
      const batch = writeBatch(db)
      bids.docs.forEach((b) => batch.delete(b.ref))
      batch.delete(it.ref)
      await batch.commit()
    }

    await setDoc(doc(db, 'settings', 'auction'), { ...settings, biddingOpen: !args.closed, message: '' })

    const batch = writeBatch(db)
    for (const item of scheduled) {
      batch.set(doc(db, 'items', item.id), { ...newItemDoc(item), endTime: Timestamp.fromDate(item.endTime) })
    }
    batch.set(catalogRef(db), catalogDoc(scheduled))
    await batch.commit()

    if (args.admin) {
      const uid = await uidForEmail(args.admin)
      await setDoc(doc(db, 'admins', uid), {})
      console.log(`Admin: ${args.admin} (${uid})`)
    }
  })

  const first = scheduled.reduce((a, b) => (a.endTime < b.endTime ? a : b))
  const last = scheduled.reduce((a, b) => (a.endTime > b.endTime ? a : b))
  console.log(`Seeded ${scheduled.length} items. First closes ${first.endTime.toLocaleString()}, last ${last.endTime.toLocaleString()}.`)
} finally {
  await env.cleanup()
}

async function uidForEmail(email) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ email: [email] }),
  })
  const body = await res.json()
  const uid = body.users?.[0]?.localId
  if (!uid) {
    console.error(`No emulator user with email ${email}. Sign in once in the app first.`)
    process.exit(1)
  }
  return uid
}
