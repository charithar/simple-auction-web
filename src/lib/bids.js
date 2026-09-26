import { doc, getDocFromServer, runTransaction, serverTimestamp } from 'firebase/firestore'
import { validateBid, minNextBid, effectiveEnd, formatMoney } from './auction.js'

export class BidError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// User-facing message for anything placeBid() can throw.
export function bidErrorMessage(e) {
  if (e instanceof BidError) return e.message
  switch (e?.code) {
    case 'permission-denied':
      return 'Your bid was not accepted. Someone may have outbid you or the item just closed. Check the price and try again.'
    case 'aborted':
    case 'failed-precondition':
      return 'Lots of bids are coming in right now. Please try again.'
    case 'unavailable':
      return 'You appear to be offline. Check your connection and try again.'
    case 'resource-exhausted':
      return 'The auction is temporarily over capacity. Please try again later.'
    default:
      return 'Something went wrong placing your bid. Please try again.'
  }
}

// "Outbid" message with the item's new price and minimum. If the new leader is
// this same user (a quick second click, another tab or another device), say so
// instead of "someone else".
function outbidError(item, settings, uid) {
  const price = formatMoney(item.currency, item.currentAmount)
  const min = formatMoney(item.currency, minNextBid(item, settings))
  return new BidError(
    'outbid',
    item.highBidderUid === uid
      ? `You're already the highest bidder, at ${price}. The minimum to raise your bid is ${min}.`
      : `Someone else bid first. The price is now ${price}; the minimum bid is ${min}.`,
  )
}

// A bid denied on an unchanged item within this margin of its end is reported as
// "just closed": the client's clock is only an estimate of the server's.
const CLOSE_MARGIN_MS = 2000

// Places a bid atomically: updates the item and creates items/{id}/bids/{n}.
// If another bid commits between our read and our write, either the SDK retries
// the transaction and our check sees the higher price, or the rules deny ours
// (permission-denied, which the SDK does not retry). Both are reported as
// 'outbid' with the new minimum: the first by comparing with seenBidCount (the
// bid count the bidder was looking at), the second by re-reading the item.
// A denial while the item is unchanged means bidding was closed (maybe only
// for a moment), the item closed between our check and the commit, or a
// transient failure during a simultaneous bid (the emulator's locking). From
// the second denial on, the settings are re-read (one read) to tell these apart;
// a denial that no longer applies is retried, up to three attempts in all.
// `now` should be the estimated server time (Date.now() + clock offset).
export async function placeBid(db, { itemId, uid, amount, settings, now = Date.now(), seenBidCount = null }) {
  const itemRef = doc(db, 'items', itemId)
  const offset = now - Date.now()
  const serverNow = () => Date.now() + offset
  for (let attempt = 1; ; attempt++) {
    let seen = null
    try {
      const args = { itemId, uid, amount, settings, now: serverNow(), seenBidCount }
      return await bidTransaction(db, itemRef, args, (item) => (seen = item))
    } catch (e) {
      if (e.code !== 'permission-denied' || !seen) throw e
      // From the server: with a live listener on this item, getDoc() may answer
      // from a cache that hasn't received the competing bid yet.
      const fresh = (await getDocFromServer(itemRef)).data()
      if (fresh && fresh.bidCount !== seen.bidCount) throw outbidError(fresh, settings, uid)
      if (attempt >= 2) {
        // Say why when we can tell: the admin closed bidding (before our settings
        // listener heard of it), or the item closed.
        const current = (await getDocFromServer(doc(db, 'settings', 'auction'))).data()
        if (current && current.biddingOpen !== true) throw new BidError('closed', 'Bidding is currently closed.')
        if (fresh && serverNow() + CLOSE_MARGIN_MS >= effectiveEnd(fresh, current ?? settings)) {
          throw new BidError('ended', 'Bidding on this item has just closed.')
        }
        // Open, and not closing: whatever refused us has passed (e.g. a pause of
        // under a second). Try once more before giving up.
        if (attempt >= 3) throw e
      }
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 300))
    }
  }
}

const bidTransaction = (db, itemRef, { itemId, uid, amount, settings, now, seenBidCount }, onRead) =>
  runTransaction(db, async (tx) => {
    const snap = await tx.get(itemRef)
    if (!snap.exists()) throw new BidError('not-found', 'Item not found.')

    const item = snap.data()
    onRead(item)
    const check = validateBid(item, settings, amount, now)
    if (!check.ok) {
      // The price moved since the bidder looked (typically the SDK retrying after
      // a competing bid): that's being outbid, not typing too little.
      if (check.code === 'too-low' && seenBidCount != null && item.bidCount > seenBidCount) {
        throw outbidError(item, settings, uid)
      }
      throw new BidError(check.code, check.message)
    }

    const n = item.bidCount + 1
    tx.update(itemRef, {
      currentAmount: amount,
      highBidderUid: uid,
      bidCount: n,
      lastBidAt: serverTimestamp(),
    })
    tx.set(doc(db, 'items', itemId, 'bids', String(n)), {
      amount,
      uid,
      createdAt: serverTimestamp(),
    })
    return { bidCount: n, amount }
  })
