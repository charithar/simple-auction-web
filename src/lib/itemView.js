import { effectiveEnd, minNextBid, maxNextBid } from './auction.js'

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
