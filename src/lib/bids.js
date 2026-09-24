import { doc, runTransaction, serverTimestamp } from 'firebase/firestore'
import { validateBid } from './auction.js'

export class BidError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// Places a bid atomically: updates the item and creates items/{id}/bids/{n}.
// If another bid lands first, the SDK retries the transaction and validation
// runs again against the fresh item, so a stale bid fails with 'too-low'.
// `now` should be the estimated server time (see useServerClock).
export const placeBid = (db, { itemId, uid, amount, settings, now = Date.now() }) =>
  runTransaction(db, async (tx) => {
    const itemRef = doc(db, 'items', itemId)
    const snap = await tx.get(itemRef)
    if (!snap.exists()) throw new BidError('not-found', 'Item not found.')

    const item = snap.data()
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
