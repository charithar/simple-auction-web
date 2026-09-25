import {
  collection, collectionGroup, deleteField, doc, getDoc, getDocs, orderBy, query, runTransaction, setDoc,
  Timestamp, writeBatch,
} from 'firebase/firestore'
import { newItemDoc } from './importItems.js'
import { effectiveEnd, toMillis } from './auction.js'
import { catalogRef, catalogDoc, CATALOG_FIELDS } from './catalog.js'

// Fields an import may change on an existing item. Bid state
// (currentAmount, bidCount, highBidderUid, lastBidAt) is never touched,
// except currentAmount follows startingPrice while an item has no bids.
const STATIC_FIELDS = [
  'order', 'title', 'subtitle', 'category', 'condition', 'specs', 'detail', 'images',
  'currency', 'startingPrice', 'endTime', 'minIncrement', 'maxIncrement',
]
// Changing these after bids exist changes the terms bidders agreed to.
const SENSITIVE_WITH_BIDS = ['startingPrice', 'endTime', 'minIncrement', 'maxIncrement']

const same = (a, b) => {
  if (a instanceof Date || b instanceof Date || a?.toMillis || b?.toMillis) return toMillis(a) === toMillis(b)
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

// Compares a parsed auction file with the items (and catalog) currently in Firestore.
// Pure: returns what applyImport() would do, for preview.
// existingCatalog: catalog entries ([{ id, ... }], see catalogItems) or null if none yet.
export function planImport(parsed, existingItems, existingCatalog = null) {
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
  const missingDocs = existingItems.filter((it) => !fileIds.has(it.id))
  const missing = missingDocs.map((it) => ({ id: it.id, title: it.title, hasBids: it.bidCount > 0 }))

  // Does the catalog already describe exactly these items? (Keeps a catalog-only
  // repair possible, e.g. the first import after adding the catalog.)
  const current = new Map((existingCatalog ?? []).map((e) => [e.id, e]))
  const expected = [...parsed.items, ...missingDocs]
  const catalogStale = !existingCatalog || current.size !== expected.length ||
    expected.some((it) => {
      const e = current.get(it.id)
      return !e || CATALOG_FIELDS.some((f) => !same(it[f], e[f]))
    })

  return { settings: parsed.settings, items: parsed.items, creates, updates, unchanged, missing, missingDocs, catalogStale }
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
  const removedIds = new Set()
  if (removeMissing) {
    for (const m of plan.missing.filter((x) => !x.hasBids)) {
      ops.push((b) => b.delete(doc(db, 'items', m.id)))
      removedIds.add(m.id)
      removed++
    }
  }

  await setDoc(settingsRef, settings, { merge: true })
  // Firestore batches hold at most 500 writes.
  for (let i = 0; i < ops.length; i += 450) {
    const batch = writeBatch(db)
    ops.slice(i, i + 450).forEach((op) => op(batch))
    await batch.commit()
  }

  const kept = new Map() // id -> current item, for items that got bids since the preview
  for (const { item, changes, hasBids } of plan.updates) {
    const ref = doc(db, 'items', item.id)
    await runTransaction(db, async (tx) => {
      const cur = (await tx.get(ref)).data()
      if (!cur) return
      const bidsSincePreview = !hasBids && cur.bidCount > 0
      const patch = {}
      for (const f of changes) {
        if (bidsSincePreview && SENSITIVE_WITH_BIDS.includes(f)) continue
        if (f === 'endTime') patch.endTime = Timestamp.fromDate(item.endTime)
        else patch[f] = item[f] === undefined ? deleteField() : item[f]
      }
      if (!hasBids && !bidsSincePreview && changes.includes('startingPrice')) patch.currentAmount = item.startingPrice
      if (bidsSincePreview) kept.set(item.id, cur)
      else kept.delete(item.id)
      if (Object.keys(patch).length) tx.update(ref, patch)
    })
  }

  // Rebuild the catalog from the file plus any kept items that aren't in it.
  // Items that kept their terms keep them in the catalog too.
  const catalogItems = plan.items.map((it) => {
    const cur = kept.get(it.id)
    if (!cur) return it
    const merged = { ...it }
    for (const f of SENSITIVE_WITH_BIDS) merged[f] = cur[f]
    return merged
  })
  await setDoc(catalogRef(db), catalogDoc([...catalogItems, ...plan.missingDocs.filter((d) => !removedIds.has(d.id))]))
  return { created: plan.creates.length, updated: plan.updates.length, removed, skipped: [...kept.keys()] }
}

export const updateSettings = (db, patch) => setDoc(doc(db, 'settings', 'auction'), patch, { merge: true })

// Writes a new closing time to the item and its catalog entry together.
function writeEnd(db, itemId, endTime) {
  const batch = writeBatch(db)
  batch.update(doc(db, 'items', itemId), { endTime })
  batch.set(catalogRef(db), { items: { [itemId]: { endTime } } }, { merge: true })
  return batch.commit()
}

// Pushes the item's closing time to max(effective end, now) + ms.
export function extendItem(db, item, settings, ms, now = Date.now()) {
  const base = Math.max(effectiveEnd(item, settings), now)
  return writeEnd(db, item.id, Timestamp.fromMillis(base + ms))
}

export const setItemEnd = (db, itemId, date) => writeEnd(db, itemId, Timestamp.fromDate(date))

// Deletes all bids on an item and restores its starting price.
// Only safe while bidding is paused: a bid landing mid-reset would leave an
// orphaned bid doc whose number blocks that item's future bids.
export async function resetItemBids(db, item, settings) {
  if (settings.biddingOpen) throw new Error('Pause bidding before resetting bids.')
  const bids = await getDocs(collection(db, 'items', item.id, 'bids'))
  const batch = writeBatch(db)
  bids.docs.forEach((d) => batch.delete(d.ref))
  batch.update(doc(db, 'items', item.id), {
    currentAmount: item.startingPrice, bidCount: 0, highBidderUid: null, lastBidAt: null,
  })
  await batch.commit()
  return bids.size
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
