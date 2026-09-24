import {
  collection, collectionGroup, doc, getDocFromCache, getDocsFromCache, onSnapshot, orderBy, query, where,
} from 'firebase/firestore'
import { catalogRef, catalogItems } from './catalog.js'

// Every function returns an unsubscribe callback.

// All item docs, live. Used by the admin page (few admins); bidders use the
// catalog + subscribeItem for the items they can see, to limit read fan-out.
// onChangeCount (optional) receives the number of changed docs per snapshot,
// i.e. the billed reads; used by the load test.
export const subscribeItems = (db, onItems, onError, onChangeCount) =>
  onSnapshot(
    query(collection(db, 'items'), orderBy('order')),
    (snap) => {
      onChangeCount?.(snap.docChanges().length)
      onItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    },
    onError,
  )

// One live item doc (null if it doesn't exist).
export const subscribeItem = (db, itemId, onItem, onError) =>
  onSnapshot(doc(db, 'items', itemId), (snap) => onItem(snap.exists() ? { id: snap.id, ...snap.data() } : null), onError)

// Display data for every item, one document.
export const subscribeCatalog = (db, onItems, onError) =>
  onSnapshot(catalogRef(db), (snap) => onItems(snap.exists() ? catalogItems(snap.data()) : null), onError)

export const subscribeSettings = (db, onSettings, onError) =>
  onSnapshot(doc(db, 'settings', 'auction'), (snap) => onSettings(snap.exists() ? snap.data() : null), onError)

// Item IDs the user has ever bid on (for the "Outbid" badge and "My bids" filter).
// Only the user's own bid docs are read, so this costs one read per own bid.
const myBidsQuery = (db, uid) => query(collectionGroup(db, 'bids'), where('uid', '==', uid))
const bidItemIds = (snap) => new Set(snap.docs.map((d) => d.ref.parent.parent.id))

export const subscribeMyBidItems = (db, uid, onItemIds, onError) =>
  onSnapshot(myBidsQuery(db, uid), (snap) => onItemIds(bidItemIds(snap)), onError)

// ---- local cache only (free, no network): used while reload cooldown is active ----
// Each resolves to null when nothing is cached.
const fromCache = (p) => p.catch(() => null)
export const cachedSettings = (db) =>
  fromCache(getDocFromCache(doc(db, 'settings', 'auction')).then((s) => (s.exists() ? s.data() : null)))
export const cachedCatalog = (db) =>
  fromCache(getDocFromCache(catalogRef(db)).then((s) => (s.exists() ? catalogItems(s.data()) : null)))
export const cachedItem = (db, itemId) =>
  fromCache(getDocFromCache(doc(db, 'items', itemId)).then((s) => (s.exists() ? { id: s.id, ...s.data() } : null)))
export const cachedMyBidItems = (db, uid) => fromCache(getDocsFromCache(myBidsQuery(db, uid)).then(bidItemIds))
