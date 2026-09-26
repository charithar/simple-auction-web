import { defineStore } from 'pinia'
import { ref, shallowRef, computed, watch } from 'vue'
import { db } from '../firebase.js'
import { subscribeItems, subscribeSettings, subscribeMyBidItems } from '../lib/items.js'
import { retryDelay } from '../lib/retry.js'
import { useAuthStore } from './auth.js'

// While signed in, three live listeners: settings, all items (lot order) and the
// user's own bids. Every card always shows the current price. Cost on the Blaze
// plan: ~22 reads per page load, 1 read per open tab per bid (see CLAUDE.md).
export const useAuctionStore = defineStore('auction', () => {
  const auth = useAuthStore()

  const docs = shallowRef([]) // item docs in lot order, as the listener delivers them
  const settings = ref(null)
  const myBidItemIds = shallowRef(new Set())
  const loaded = ref(false)
  const error = ref('')
  const reconnecting = ref(false)

  // Own bids that succeeded but aren't in the item listener yet: id -> { bidCount, amount, uid }.
  // The "my bids" listener (or noteOwnBid) can mark the item as bid on before the
  // item update arrives, which would briefly show "Outbid" (bid on, not leading).
  // Until the listener reaches that bid count, show the item as the bidder's.
  const ownPending = shallowRef(new Map())
  const withOwnBid = (it) => {
    const p = ownPending.value.get(it.id)
    return p && it.bidCount < p.bidCount
      ? { ...it, currentAmount: p.amount, bidCount: p.bidCount, highBidderUid: p.uid }
      : it
  }
  const items = computed(() => docs.value.map(withOwnBid))
  const itemsById = computed(() => new Map(items.value.map((it) => [it.id, it])))

  // A failed listener stops for good (the SDK retries network trouble itself, so
  // what reaches here is a refusal: the emergency stop, App Check, quota). Drop
  // all three listeners and attach them again on the retry schedule, so open
  // pages recover by themselves once the cause is gone.
  const onError = (e) => {
    console.error('Firestore listener failed', e)
    error.value = {
      'resource-exhausted': 'The auction is temporarily over capacity. Reconnecting automatically…',
      // The rules refuse this user everything: the admin's emergency stop is on.
      'permission-denied': 'The auction is temporarily unavailable. This page reconnects by itself.',
    }[e.code] ?? 'Lost connection to the auction. Reconnecting automatically…'
    scheduleReconnect()
  }

  let unsubs = []
  let currentUid = null
  let retryTimer = null
  let attempts = 0

  function scheduleReconnect() {
    if (retryTimer) return // already scheduled (three listeners can fail together)
    detach()
    reconnecting.value = true
    const uid = currentUid
    retryTimer = setTimeout(() => attach(uid), retryDelay(attempts++))
  }

  function attach(uid) {
    detach()
    // A pending reconnect is either this call, or for an account that's gone.
    clearTimeout(retryTimer)
    retryTimer = null
    currentUid = uid
    unsubs = [
      subscribeSettings(db, (s) => (settings.value = s), onError),
      subscribeItems(db, (list, fromCache) => {
        docs.value = list
        dropConfirmedOwnBids(list)
        loaded.value = true
        // Recovered only with fresh server data: after a reconnect the local
        // cache answers first, before the server can refuse again.
        if (!fromCache) {
          error.value = ''
          reconnecting.value = false
          attempts = 0
        }
      }, onError),
      subscribeMyBidItems(db, uid, (ids) => (myBidItemIds.value = ids), onError),
    ]
  }

  function detach() {
    unsubs.forEach((u) => u())
    unsubs = []
  }

  function reset() {
    detach()
    clearTimeout(retryTimer)
    retryTimer = null
    currentUid = null
    attempts = 0
    reconnecting.value = false
    docs.value = []
    ownPending.value = new Map()
    settings.value = null
    myBidItemIds.value = new Set()
    loaded.value = false
    error.value = ''
  }

  let started = false
  function init() {
    if (started) return
    started = true
    watch(
      () => auth.user?.uid,
      (uid) => (uid ? attach(uid) : reset()),
      { immediate: true },
    )
  }

  // After a successful bid ({ bidCount, amount } from placeBid): mark the item as
  // bid on and as led by this bidder until the listeners confirm.
  function noteOwnBid(itemId, bid) {
    if (!myBidItemIds.value.has(itemId)) myBidItemIds.value = new Set([...myBidItemIds.value, itemId])
    if (bid) ownPending.value = new Map(ownPending.value).set(itemId, { ...bid, uid: auth.user.uid })
  }

  // The item listener has caught up (or overtaken: a rival bid since): the real doc wins.
  function dropConfirmedOwnBids(list) {
    if (!ownPending.value.size) return
    const next = new Map(ownPending.value)
    for (const it of list) if (next.has(it.id) && it.bidCount >= next.get(it.id).bidCount) next.delete(it.id)
    if (next.size !== ownPending.value.size) ownPending.value = next
  }

  // For the header indicator: 'live' | 'connecting' | 'reconnecting'.
  const connection = computed(() => (reconnecting.value ? 'reconnecting' : loaded.value ? 'live' : 'connecting'))

  return { items, itemsById, settings, myBidItemIds, loaded, error, connection, init, noteOwnBid }
})
