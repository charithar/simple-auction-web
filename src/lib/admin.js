import {
  collection, collectionGroup, deleteDoc, deleteField, doc, getDoc, getDocs, orderBy, query, runTransaction,
  serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch,
} from 'firebase/firestore'
import { newItemDoc } from './importItems.js'
import { effectiveEnd, toMillis, startOf } from './auction.js'

// Fields an import may change on an existing item. Bid state
// (currentAmount, bidCount, highBidderUid, lastBidAt) is never touched,
// except currentAmount follows startingPrice while an item has no bids.
const STATIC_FIELDS = [
  'order', 'title', 'subtitle', 'category', 'condition', 'specs', 'detail', 'images',
  'currency', 'startingPrice', 'endTime', 'minIncrement', 'maxIncrement',
]
// Firestore batches hold at most 500 writes; stay below with room to spare.
const BATCH_SIZE = 450

// Changing these after bids exist changes the terms bidders agreed to.
const SENSITIVE_WITH_BIDS = ['startingPrice', 'endTime', 'minIncrement', 'maxIncrement']

const same = (a, b) => {
  if (a instanceof Date || b instanceof Date || a?.toMillis || b?.toMillis) return toMillis(a) === toMillis(b)
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

// Compares a parsed auction file with the items currently in Firestore.
// Pure: returns what applyImport() would do, for preview.
export function planImport(parsed, existingItems) {
  const existing = new Map(existingItems.map((it) => [it.id, it]))
  const creates = []
  const updates = []
  const unchanged = []

  for (const item of parsed.items) {
    const cur = existing.get(item.id)
    if (!cur) {
      creates.push(item)
      continue
    }
    const changes = STATIC_FIELDS.filter((f) => !same(item[f], cur[f]))
    const hasBids = cur.bidCount > 0
    if (changes.length === 0) unchanged.push(item.id)
    else {
      updates.push({
        item,
        changes,
        hasBids,
        warnings: hasBids ? changes.filter((f) => SENSITIVE_WITH_BIDS.includes(f)) : [],
      })
    }
  }

  const fileIds = new Set(parsed.items.map((it) => it.id))
  const missing = existingItems
    .filter((it) => !fileIds.has(it.id))
    .map((it) => ({ id: it.id, title: it.title, hasBids: it.bidCount > 0 }))

  return { settings: parsed.settings, items: parsed.items, creates, updates, unchanged, missing }
}

// Writes an import plan. Items with bids are never deleted.
// Updates run as one transaction per item, re-reading it: bidding may be open,
// and an item that received its first bid after the preview must keep its
// price, and must not get closing-time or increment changes the admin wasn't
// warned about. Those items are only partly updated and listed in `skipped`.
export async function applyImport(db, plan, { removeMissing = false } = {}) {
  const ops = []

  // Settings: merge so biddingOpen / message survive re-imports. A brand-new
  // auction starts with bidding closed; the admin opens it explicitly.
  const settingsRef = doc(db, 'settings', 'auction')
  const settingsSnap = await getDoc(settingsRef)
  const settings = {
    ...plan.settings,
    ...(settingsSnap.exists() ? {} : { biddingOpen: false, message: '' }),
  }

  for (const item of plan.creates) {
    ops.push((b) => b.set(doc(db, 'items', item.id), { ...newItemDoc(item), endTime: Timestamp.fromDate(item.endTime) }))
  }
  let removed = 0
  if (removeMissing) {
    for (const m of plan.missing.filter((x) => !x.hasBids)) {
      ops.push((b) => b.delete(doc(db, 'items', m.id)))
      removed++
    }
  }

  await setDoc(settingsRef, settings, { merge: true })
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const batch = writeBatch(db)
    ops.slice(i, i + BATCH_SIZE).forEach((op) => op(batch))
    await batch.commit()
  }

  const skipped = new Set() // items that got bids since the preview
  for (const { item, changes, hasBids } of plan.updates) {
    const ref = doc(db, 'items', item.id)
    await runTransaction(db, async (tx) => {
      const cur = (await tx.get(ref)).data()
      if (!cur) return // deleted since the preview (e.g. by another admin)
      const bidsSincePreview = !hasBids && cur.bidCount > 0
      const patch = {}
      for (const f of changes) {
        if (bidsSincePreview && SENSITIVE_WITH_BIDS.includes(f)) continue
        if (f === 'endTime') patch.endTime = Timestamp.fromDate(item.endTime)
        else patch[f] = item[f] === undefined ? deleteField() : item[f]
      }
      // The price follows the starting price while the item has no bids, judged
      // now (bids may have landed, or been reset, since the preview).
      if (cur.bidCount === 0 && changes.includes('startingPrice')) patch.currentAmount = item.startingPrice
      if (bidsSincePreview) skipped.add(item.id)
      else skipped.delete(item.id)
      if (Object.keys(patch).length) tx.update(ref, patch)
    })
  }

  return { created: plan.creates.length, updated: plan.updates.length, removed, skipped: [...skipped] }
}

export const updateSettings = (db, patch) => setDoc(doc(db, 'settings', 'auction'), patch, { merge: true })

// The global start (null clears it): with bidding switched on, bids are accepted from then.
export const setStartTime = (db, date) =>
  updateSettings(db, { startTime: date ? Timestamp.fromDate(date) : null })

// Emergency stop: while settings/killswitch exists the rules refuse everyone
// but admins (see firestore.rules live()).
export const setKillSwitch = (db, on) => {
  const ref = doc(db, 'settings', 'killswitch')
  return on ? setDoc(ref, { since: serverTimestamp() }) : deleteDoc(ref)
}

const writeEnd = (db, itemId, endTime) => updateDoc(doc(db, 'items', itemId), { endTime })

// Pushes the item's closing time to max(effective end, now) + ms.
export function extendItem(db, item, settings, ms, now = Date.now()) {
  const base = Math.max(effectiveEnd(item, settings), now)
  return writeEnd(db, item.id, Timestamp.fromMillis(base + ms))
}

export const setItemEnd = (db, itemId, date) => writeEnd(db, itemId, Timestamp.fromDate(date))

// Sets the closing time to `ms` from now (e.g. to try anti-sniping). A bid in the
// last antiSnipeSeconds still keeps the item open past it, as in a real close.
export const endItemIn = (db, itemId, ms, now = Date.now()) => writeEnd(db, itemId, Timestamp.fromMillis(now + ms))

// Setting up the auction: every item's closing time from one schedule, in lot
// order: the first closes at `firstEnd` (ms), each next one `staggerMs` later
// (like auction.endTime and stagger in the file). Only before any bids: the
// closing time is part of the terms bidders see. Pure: { ends: [{ id, order, end }] }
// or { error }.
export function planSchedule(items, firstEnd, staggerMs, settings, now = Date.now()) {
  if (!items.length) return { error: 'There are no items yet.' }
  const withBids = items.filter((it) => it.bidCount > 0)
  if (withBids.length) {
    return { error: `Only before any bids: ${withBids.length} item(s) already have bids. Use the per-item controls, or reset all bids first.` }
  }
  if (!Number.isFinite(firstEnd)) return { error: 'Choose when the first item closes.' }
  if (!Number.isInteger(staggerMs) || staggerMs < 0) return { error: 'The gap must look like 30s, 1m or 2h.' }
  if (staggerMs > 86_400_000) return { error: 'The gap can be at most 24h.' }
  // Firestore stores times up to the year 9999.
  if (firstEnd + (items.length - 1) * staggerMs >= Date.UTC(10000, 0, 1)) return { error: 'That is too far in the future.' }
  if (firstEnd <= now) return { error: 'The first closing time is in the past.' }
  const start = startOf(settings)
  if (start != null && firstEnd <= start) return { error: 'Items must close after bidding starts.' }
  const ends = [...items].sort((a, b) => a.order - b.order).map((it, i) => ({ id: it.id, order: it.order, end: firstEnd + i * staggerMs }))
  return { ends }
}

// The schedule the items follow now, to pre-fill the form: the first (earliest)
// closing time, and the gap between lots when it is the same all the way (else null).
export function currentSchedule(items) {
  if (!items.length) return { firstEnd: null, staggerMs: null }
  const ends = [...items].sort((a, b) => a.order - b.order).map((it) => toMillis(it.endTime))
  const gaps = ends.slice(1).map((e, i) => e - ends[i])
  const even = gaps.every((g) => g === gaps[0] && g >= 0)
  return { firstEnd: Math.min(...ends), staggerMs: even ? (gaps[0] ?? 0) : null }
}

// "lot 3", "lots 3 and 5", "lots 3, 5, 7 and 2 more": for messages naming items (lot order).
export function lotsText(items, max = 3) {
  const orders = items.map((it) => it.order).sort((a, b) => a - b)
  if (orders.length === 1) return `lot ${orders[0]}`
  const shown = orders.slice(0, max)
  const rest = orders.length - shown.length
  return rest > 0 ? `lots ${shown.join(', ')} and ${rest} more` : `lots ${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

// Writes a planned schedule in one transaction, re-checking that no item got a
// bid since the plan (admin writes skip the bid rules). Returns the item count.
export function setClosingSchedule(db, ends) {
  return runTransaction(db, async (tx) => {
    const refs = ends.map((e) => doc(db, 'items', e.id))
    const snaps = await Promise.all(refs.map((r) => tx.get(r)))
    if (snaps.some((s) => (s.data()?.bidCount ?? 0) > 0)) {
      throw new Error('An item got a bid in the meantime: closing times were not changed.')
    }
    refs.forEach((r, i) => snaps[i].exists() && tx.update(r, { endTime: Timestamp.fromMillis(ends[i].end) }))
    return snaps.filter((s) => s.exists()).length
  })
}

// Deletes all bids on an item and restores its starting price.
// Only safe while bidding is paused: a bid landing mid-reset would leave an
// orphaned bid doc whose number blocks that item's future bids (the rules
// refuse bid deletes while bidding is open).
// Bids go first, in chunks (a batch holds at most 500 writes), and the item
// last: if the reset stops midway, the item still counts its bids and running
// it again finishes the job. Resetting the item first could leave bid numbers
// behind that block new bids.
export async function resetItemBids(db, item, settings) {
  if (settings.biddingOpen) throw new Error('Pause bidding before resetting bids.')
  const bids = (await getDocs(collection(db, 'items', item.id, 'bids'))).docs
  let i = 0
  for (; bids.length - i > BATCH_SIZE; i += BATCH_SIZE) {
    const batch = writeBatch(db)
    bids.slice(i, i + BATCH_SIZE).forEach((d) => batch.delete(d.ref))
    await batch.commit()
  }
  const batch = writeBatch(db)
  bids.slice(i).forEach((d) => batch.delete(d.ref))
  batch.update(doc(db, 'items', item.id), {
    currentAmount: item.startingPrice, bidCount: 0, highBidderUid: null, lastBidAt: null,
  })
  await batch.commit()
  return bids.length
}

// Resets every item to its state before the first bid: all bids deleted,
// starting price, no leader, no anti-snipe extension. Items, their closing
// times, settings, bidder profiles and admins are kept. Only while bidding is
// paused. Returns { items, bids } counts.
export async function resetAllBids(db, items, settings) {
  if (settings.biddingOpen) throw new Error('Pause bidding before resetting bids.')
  let bids = 0
  for (const item of items) bids += await resetItemBids(db, item, settings)
  return { items: items.length, bids }
}

export async function fetchItemBids(db, itemId) {
  const snap = await getDocs(query(collection(db, 'items', itemId, 'bids'), orderBy('createdAt', 'desc')))
  return snap.docs.map((d) => ({ n: Number(d.id), ...d.data() }))
}

export async function fetchAllBids(db) {
  const snap = await getDocs(collectionGroup(db, 'bids'))
  return snap.docs.map((d) => ({ itemId: d.ref.parent.parent.id, n: Number(d.id), ...d.data() }))
}

// Cached users/{uid} lookups: each bidder costs one read per admin session.
export function createUserCache(db) {
  const cache = new Map()
  return (uid) => {
    if (!cache.has(uid)) {
      cache.set(uid, getDoc(doc(db, 'users', uid)).then((s) => (s.exists() ? s.data() : null)).catch(() => null))
    }
    return cache.get(uid)
  }
}

// ---------- CSV ----------

// Bidders choose their own names, so text cells starting with = + - @ (or a
// tab/CR) get a leading ' to stop Excel from running them as formulas.
// Numbers are left alone so they stay numeric.
const csvCell = (v) => {
  let s = v == null ? '' : String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// BOM so Excel opens UTF-8 correctly.
export const toCsv = (header, rows) =>
  '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')

const iso = (ms) => (ms == null ? '' : new Date(ms).toISOString())

export function winnersCsv(items, settings, users, now = Date.now()) {
  return toCsv(
    ['Lot', 'Title', 'Subtitle', 'Status', 'Final price', 'Currency', 'Bids', 'Winner', 'Winner email', 'Closes/closed (UTC)'],
    [...items].sort((a, b) => a.order - b.order).map((it) => {
      const end = effectiveEnd(it, settings)
      const u = it.highBidderUid ? users.get(it.highBidderUid) : null
      return [
        it.order, it.title, it.subtitle,
        it.bidCount === 0 ? 'No bids' : end <= now ? 'Sold' : 'Open',
        it.bidCount === 0 ? '' : it.currentAmount, it.currency, it.bidCount,
        u?.name ?? (it.highBidderUid ? it.highBidderUid : ''), u?.email ?? '', iso(end),
      ]
    }),
  )
}

// One row per bidder, one column per lot (lot order): how many bids each bidder
// placed on each item, a total per bidder and a totals row. Every item gets a
// column, with or without bids; a bid on an item that no longer exists gets a
// column named after its id, so the totals still add up.
export function bidCountsCsv(bids, items, users) {
  const columns = [...items].sort((a, b) => a.order - b.order).map((it) => ({ id: it.id, label: `Lot ${it.order}: ${it.title}` }))
  const known = new Set(columns.map((c) => c.id))
  for (const id of [...new Set(bids.map((b) => b.itemId))].filter((id) => !known.has(id)).sort()) {
    columns.push({ id, label: id })
  }
  const byUid = new Map()
  for (const b of bids) {
    if (!byUid.has(b.uid)) byUid.set(b.uid, new Map())
    const counts = byUid.get(b.uid)
    counts.set(b.itemId, (counts.get(b.itemId) ?? 0) + 1)
  }
  const rows = [...byUid].map(([uid, counts]) => {
    const u = users.get(uid)
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
    return [u?.name ?? uid, u?.email ?? '', total, ...columns.map((c) => counts.get(c.id) ?? 0)]
  })
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { sensitivity: 'base' }) || a[1].localeCompare(b[1]))
  const totals = ['Total', '', bids.length, ...columns.map((c) => bids.filter((b) => b.itemId === c.id).length)]
  return toCsv(['Bidder', 'Bidder email', 'Total bids', ...columns.map((c) => c.label)], [...rows, totals])
}

export function bidsCsv(bids, itemsById, users) {
  return toCsv(
    ['Lot', 'Title', 'Bid #', 'Amount', 'Bidder', 'Bidder email', 'Placed (UTC)'],
    [...bids]
      .sort((a, b) => (itemsById.get(a.itemId)?.order ?? 0) - (itemsById.get(b.itemId)?.order ?? 0) || a.n - b.n)
      .map((b) => {
        const it = itemsById.get(b.itemId)
        const u = users.get(b.uid)
        return [it?.order ?? '', it?.title ?? b.itemId, b.n, b.amount, u?.name ?? b.uid, u?.email ?? '', iso(toMillis(b.createdAt))]
      }),
  )
}
