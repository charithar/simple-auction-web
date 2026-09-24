import { collection, collectionGroup, doc, onSnapshot, orderBy, query, where } from 'firebase/firestore'

// Every function returns an unsubscribe callback.

export const subscribeItems = (db, onItems, onError) =>
  onSnapshot(
    query(collection(db, 'items'), orderBy('order')),
    (snap) => onItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError,
  )

export const subscribeSettings = (db, onSettings, onError) =>
  onSnapshot(doc(db, 'settings', 'auction'), (snap) => onSettings(snap.exists() ? snap.data() : null), onError)

// Item IDs the user has ever bid on (for the "Outbid" badge and "My bids" filter).
// Only the user's own bid docs are read, so this costs one read per own bid.
export const subscribeMyBidItems = (db, uid, onItemIds, onError) =>
  onSnapshot(
    query(collectionGroup(db, 'bids'), where('uid', '==', uid)),
    (snap) => onItemIds(new Set(snap.docs.map((d) => d.ref.parent.parent.id))),
    onError,
  )
