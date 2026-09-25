import { load } from 'js-yaml'
import { imageUrlOk } from './images.js'

// Auction file format (YAML or JSON). See data/auction.yml for a full example.
//
// auction:
//   title: IT Equipment Auction          # shown in the header
//   currency: Rs.                        # default for items
//   minIncrement: 50                     # global bid increments (items may override)
//   maxIncrement: 1000                   # optional; omit for no cap
//   antiSnipeSeconds: 120                # late bids extend the item to lastBid + this
//   endTime: 2026-10-31T18:00:00+05:30   # when the first item closes
//   stagger: 1m                          # optional: each next item (in list order) closes this much later
// items:
//   - id: 0                              # stable whole number; the document ID derives from it
//     title: HP ProDesk 400 G4
//     subtitle: SAMPLE0001               # e.g. serial / asset tag
//     category: Desktop
//     condition: Used - good
//     specs: { CPU: Core i5, RAM: 16 GB, Storage: 1 TB HDD }
//     detail: Free text shown in the item window.
//     images: [https://...]              # https:// URLs or paths relative to the site (images/lot-0.webp)
//     startingPrice: 6000
//     endTime: ...                       # optional per-item override
//     minIncrement / maxIncrement / currency   # optional per-item overrides
//
// Returns { settings, items, errors }. Only usable when errors is empty.
export function parseAuctionFile(text) {
  let raw
  try {
    raw = load(text)
  } catch (e) {
    return fail([`File is not valid YAML/JSON: ${e.message}`])
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(['Expected top-level "auction" and "items" sections.'])
  }

  const errors = []
  const a = raw.auction ?? {}
  const aErr = (msg) => errors.push(`auction: ${msg}`)

  const settings = {
    title: str(a.title) || 'Auction',
    minIncrement: a.minIncrement,
    antiSnipeSeconds: a.antiSnipeSeconds ?? 120,
    maxIncrement: a.maxIncrement ?? null,
  }
  if (!posInt(settings.minIncrement)) aErr('minIncrement must be a positive whole number')
  if (settings.maxIncrement != null && !posInt(settings.maxIncrement)) aErr('maxIncrement must be a positive whole number')
  if (!Number.isInteger(settings.antiSnipeSeconds) || settings.antiSnipeSeconds < 0) {
    aErr('antiSnipeSeconds must be a whole number ≥ 0')
  }

  const auctionEnd = a.endTime == null ? null : toDate(a.endTime)
  if (a.endTime != null && auctionEnd == null) aErr('endTime must be an ISO 8601 date')
  const staggerMs = a.stagger == null ? 0 : parseDuration(a.stagger)
  if (staggerMs == null) aErr('stagger must look like 30s, 1m, 2h or a number of seconds')

  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    errors.push('items: expected a non-empty list')
    return fail(errors)
  }

  const seen = new Set()
  const items = raw.items.map((r, i) => {
    const where = `items[${i}]${r?.id != null ? ` (id ${r.id})` : ''}`
    const err = (msg) => errors.push(`${where}: ${msg}`)
    if (r == null || typeof r !== 'object' || Array.isArray(r)) {
      err('not an object')
      return null
    }

    if (!Number.isInteger(r.id) || r.id < 0) err('id must be a whole number ≥ 0')
    else if (seen.has(r.id)) err('duplicate id')
    seen.add(r.id)

    if (!nonEmpty(r.title)) err('title is required')
    if (!posInt(r.startingPrice)) err('startingPrice must be a positive whole number')
    for (const k of ['minIncrement', 'maxIncrement']) {
      if (r[k] != null && !posInt(r[k])) err(`${k} must be a positive whole number`)
    }
    const minInc = r.minIncrement ?? settings.minIncrement
    const maxInc = r.maxIncrement ?? settings.maxIncrement
    if (posInt(minInc) && maxInc != null && maxInc < minInc) err('maxIncrement is smaller than minIncrement')

    let endTime = null
    if (r.endTime != null) {
      endTime = toDate(r.endTime)
      if (endTime == null) err('endTime must be an ISO 8601 date')
    } else if (auctionEnd != null && staggerMs != null) {
      endTime = new Date(auctionEnd.getTime() + i * staggerMs)
    } else if (auctionEnd == null) {
      err('no endTime (set auction.endTime or the item endTime)')
    }

    if (r.specs != null && (typeof r.specs !== 'object' || Array.isArray(r.specs))) {
      err('specs must be a map of name: value')
    }
    if (r.images != null && !Array.isArray(r.images)) err('images must be a list of URLs')
    const images = [...new Set((Array.isArray(r.images) ? r.images : []).filter(nonEmpty).map((u) => u.trim()))]
    for (const u of images.filter((u) => !imageUrlOk(u))) {
      err(`image "${u}" must be an https:// URL or a relative path like images/lot-0.webp`)
    }

    const item = {
      id: itemDocId(r.id),
      order: r.id,
      title: str(r.title),
      subtitle: str(r.subtitle),
      category: str(r.category),
      condition: str(r.condition),
      specs: Object.entries(r.specs ?? {}).map(([name, value]) => ({ name: str(name), value: str(value) })),
      detail: str(r.detail),
      images,
      currency: str(r.currency) || str(a.currency) || 'Rs.',
      startingPrice: r.startingPrice,
      endTime,
    }
    if (r.minIncrement != null) item.minIncrement = r.minIncrement
    if (r.maxIncrement != null) item.maxIncrement = r.maxIncrement
    return item
  })

  return errors.length ? fail(errors) : { settings, items, errors: [] }
}

// "item-007": zero-padded so document IDs sort like the numeric ids.
export const itemDocId = (id) => `item-${String(id).padStart(3, '0')}`

// Moves every end time so the earliest item closes at `firstEnd`, keeping gaps.
// Used to replay a real auction file against the emulator.
export function shiftEndTimes(items, firstEnd) {
  const earliest = Math.min(...items.map((it) => it.endTime.getTime()))
  return items.map((it) => ({
    ...it,
    endTime: new Date(firstEnd.getTime() + (it.endTime.getTime() - earliest)),
  }))
}

// Full Firestore document for a freshly imported item (no bids yet).
// Callers convert endTime to a Timestamp.
export const newItemDoc = (item) => {
  const { id: _id, ...fields } = item
  return { ...fields, currentAmount: item.startingPrice, bidCount: 0, highBidderUid: null, lastBidAt: null }
}

// "90" / 90 -> seconds; "30s", "5m", "2h" -> ms. Returns null when invalid.
export function parseDuration(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v * 1000 : null
  const m = /^\s*(\d+)\s*(s|m|h)?\s*$/i.exec(String(v))
  if (!m) return null
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's').toLowerCase()]
}

const fail = (errors) => ({ settings: null, items: [], errors })
const toDate = (v) => {
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}
const posInt = (v) => Number.isInteger(v) && v > 0
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''
const str = (v) => (v == null ? '' : String(v).trim())
