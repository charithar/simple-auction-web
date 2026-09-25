import { effectiveEnd, minNextBid, maxNextBid, toMillis } from './auction.js'

// Catalog-only item (live doc not loaded yet): the scheduled end is known,
// price, bids and anti-snipe extensions are not.
export function pendingView(item, now) {
  const end = toMillis(item.endTime)
  const remaining = end - now
  return {
    live: false,
    end,
    remaining,
    ended: remaining <= 0,
    extended: false,
    status: remaining <= 0 ? 'ended' : remaining < 5 * 60_000 ? 'closing' : 'open',
    standing: null,
    canBid: false,
    minBid: null,
    maxBid: null,
  }
}

// Text to pre-fill the bid box with: the minimum bid, or empty while the price
// is still loading (the dialog fills it in when the live data arrives).
export const initialBidText = (view) => (view?.minBid != null ? String(view.minBid) : '')

// Picks the right view for a merged store item.
export const viewFor = (item, ctx) => (item.live ? itemView(item, ctx) : pendingView(item, ctx.now))

// Derived, per-viewer state of an item at time `now`.
// status: 'open' | 'closing' (under 5 min) | 'ended'
// standing: null | 'winning' | 'outbid' | 'won' | 'lost'
export function itemView(item, { settings, uid, myBidItemIds, now }) {
  const end = effectiveEnd(item, settings)
  const remaining = end - now
  const ended = remaining <= 0
  const isHigh = uid != null && item.highBidderUid === uid
  const hasBid = isHigh || myBidItemIds.has(item.id)

  let standing = null
  if (hasBid) standing = ended ? (isHigh ? 'won' : 'lost') : isHigh ? 'winning' : 'outbid'

  return {
    live: true,
    end,
    remaining,
    ended,
    extended: end > item.endTime.toMillis(),
    status: ended ? 'ended' : remaining < 5 * 60_000 ? 'closing' : 'open',
    standing,
    canBid: !ended && settings.biddingOpen === true,
    minBid: minNextBid(item, settings),
    maxBid: maxNextBid(item, settings),
  }
}
