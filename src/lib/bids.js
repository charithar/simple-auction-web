import { doc, getDocFromServer, runTransaction, serverTimestamp } from 'firebase/firestore'
import { validateBid, minNextBid, formatMoney } from './auction.js'

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

// Places a bid atomically: updates the item and creates items/{id}/bids/{n}.
// If another bid commits between our read and our write, the rules evaluate
// against the newer item and deny ours (permission-denied, which the SDK does
// not retry). We then re-read and report it as 'outbid' with the new minimum.
// A denial while the item is unchanged means a transient failure during a
// simultaneous bid (seen with the emulator's locking); we retry once.
// `now` should be the estimated server time (see useNow).
export async function placeBid(db, { itemId, uid, amount, settings, now = Date.now() }) {
  const itemRef = doc(db, 'items', itemId)
  for (let attempt = 1; ; attempt++) {
    let seen = null
    try {
      return await bidTransaction(db, itemRef, { itemId, uid, amount, settings, now }, (item) => (seen = item))
    } catch (e) {
      if (e.code !== 'permission-denied' || !seen) throw e
      // From the server: with a live listener on this item, getDoc() may answer
      // from a cache that hasn't received the competing bid yet.
      const fresh = (await getDocFromServer(itemRef)).data()
      if (fresh && fresh.bidCount !== seen.bidCount) {
        throw new BidError(
          'outbid',
          `Someone else bid first. The price is now ${formatMoney(fresh.currency, fresh.currentAmount)}; ` +
            `the minimum bid is ${formatMoney(fresh.currency, minNextBid(fresh, settings))}.`,
        )
      }
      if (attempt >= 2) throw e
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 300))
    }
  }
}

const bidTransaction = (db, itemRef, { itemId, uid, amount, settings, now }, onRead) =>
  runTransaction(db, async (tx) => {
    const snap = await tx.get(itemRef)
    if (!snap.exists()) throw new BidError('not-found', 'Item not found.')

    const item = snap.data()
    onRead(item)
    const check = validateBid(item, settings, amount, now)
    if (!check.ok) throw new BidError(check.code, check.message)

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
