import { effectiveEnd, minNextBid, maxNextBid, notStartedYet, startOf, biddingClosed } from './auction.js'

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
// status: 'upcoming' (switched on, start time not reached) | 'open' | 'closing' (under 5 min) | 'ended'
// final: under FINAL_MS left (never while upcoming); startsIn: ms until the start while upcoming
// standing: null | 'winning' | 'outbid' | 'won' | 'lost'
export function viewFor(item, { settings, uid, myBidItemIds, now }) {
  const end = effectiveEnd(item, settings)
  const remaining = end - now
  const ended = remaining <= 0
  const isHigh = uid != null && item.highBidderUid === uid
  const hasBid = isHigh || myBidItemIds.has(item.id)
  const upcoming = !ended && notStartedYet(settings, now)

  let standing = null
  if (hasBid) standing = ended ? (isHigh ? 'won' : 'lost') : isHigh ? 'winning' : 'outbid'

  return {
    end,
    remaining,
    ended,
    extended: end > item.endTime.toMillis(),
    status: ended ? 'ended' : upcoming ? 'upcoming' : remaining < 5 * 60_000 ? 'closing' : 'open',
    final: !ended && !upcoming && remaining < FINAL_MS,
    upcoming,
    startsIn: upcoming ? startOf(settings) - now : 0,
    standing,
    canBid: !ended && !upcoming && !biddingClosed(settings),
    minBid: minNextBid(item, settings),
    maxBid: maxNextBid(item, settings),
  }
}
