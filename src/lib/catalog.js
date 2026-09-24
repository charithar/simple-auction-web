import { doc, Timestamp } from 'firebase/firestore'

// catalog/items holds the display data of every item in one document:
//   { items: { 'item-007': { order, title, ..., endTime }, ... } }
// Bidders read it once per page load (1 read instead of one per item) and only
// listen to live item docs they can see. items/{id} stays authoritative for
// bidding; the catalog's endTime is the scheduled close, kept in sync by admin
// actions but not by anti-snipe extensions (those come from the live doc).

export const CATALOG_FIELDS = [
  'order', 'title', 'subtitle', 'category', 'condition', 'specs', 'detail', 'images',
  'currency', 'startingPrice', 'endTime', 'minIncrement', 'maxIncrement',
]

export const catalogRef = (db) => doc(db, 'catalog', 'items')

// Picks catalog fields; converts a Date endTime to a Timestamp.
export function catalogEntry(item) {
  const e = {}
  for (const f of CATALOG_FIELDS) if (item[f] !== undefined) e[f] = item[f]
  if (e.endTime instanceof Date) e.endTime = Timestamp.fromDate(e.endTime)
  return e
}

export const catalogDoc = (items) => ({
  items: Object.fromEntries(items.map((it) => [it.id, catalogEntry(it)])),
})

// Document data -> items sorted by lot number.
export const catalogItems = (data) =>
  Object.entries(data?.items ?? {})
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => a.order - b.order)
