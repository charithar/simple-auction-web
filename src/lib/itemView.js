import { effectiveEnd, minNextBid, maxNextBid } from './auction.js'

// The last minutes of an item: highlighted on the card, since that's when
// anti-snipe extensions and last bids happen.
export const FINAL_MS = 2 * 60_000

// Text to pre-fill the bid box with: the minimum bid, or empty if there's no view.
export const initialBidText = (view) => (view?.minBid != null ? String(view.minBid) : '')

// The grid's filter tabs.
export function matchesFilter(filter, view) {
  if (filter === 'mine') return !!view.standing
  if (filter === 'outbid') return view.standing === 'outbid'
  if (filter === 'open') return !view.ended
  return true
}

// Derived, per-viewer state of an item at time `now`.
// status: 'open' | 'closing' (under 5 min) | 'ended'; final: under FINAL_MS left
// standing: null | 'winning' | 'outbid' | 'won' | 'lost'
export function viewFor(item, { settings, uid, myBidItemIds, now }) {
  const end = effectiveEnd(item, settings)
  const remaining = end - now
  const ended = remaining <= 0
  const isHigh = uid != null && item.highBidderUid === uid
  const hasBid = isHigh || myBidItemIds.has(item.id)

  let standing = null
  if (hasBid) standing = ended ? (isHigh ? 'won' : 'lost') : isHigh ? 'winning' : 'outbid'

  return {
    end,
    remaining,
    ended,
    extended: end > item.endTime.toMillis(),
    status: ended ? 'ended' : remaining < 5 * 60_000 ? 'closing' : 'open',
    final: !ended && remaining < FINAL_MS,
    standing,
    canBid: !ended && settings.biddingOpen === true,
    minBid: minNextBid(item, settings),
    maxBid: maxNextBid(item, settings),
  }
}
