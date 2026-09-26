import { formatMoney } from './auction.js'

// The bidder's own position across all items, from the grid rows
// ([{ item, view }], view from lib/itemView.js). Pure, for the summary panel
// and the outbid alerts.

// Items grouped by the viewer's standing.
export function myBidsSummary(rows) {
  const out = { winning: [], outbid: [], won: [], lost: [] }
  for (const { item, view } of rows) if (out[view.standing]) out[view.standing].push(item)
  return out
}

// Sum of the items' current prices, per currency: "Rs. 45,000" or "Rs. 45,000 + USD 120".
export function formatTotal(items) {
  const sums = new Map()
  for (const it of items) sums.set(it.currency, (sums.get(it.currency) ?? 0) + it.currentAmount)
  return [...sums].map(([currency, sum]) => formatMoney(currency, sum)).join(' + ')
}

// id -> standing, to compare snapshots.
export const standings = (rows) => new Map(rows.map(({ item, view }) => [item.id, view.standing]))

// Items that went from winning to outbid since `before` (a standings() map).
// Items not in `before` (first load) never count, so opening the page doesn't alert.
export const newlyOutbid = (before, rows) =>
  rows.filter(({ item, view }) => view.standing === 'outbid' && before.get(item.id) === 'winning').map(({ item }) => item)
