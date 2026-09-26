import { defineStore } from 'pinia'
import { ref, shallowRef, computed, watch } from 'vue'
import { db } from '../firebase.js'
import { subscribeItems, subscribeSettings, subscribeMyBidItems } from '../lib/items.js'
import { useAuthStore } from './auth.js'

// While signed in, three live listeners: settings, all items (lot order) and the
// user's own bids. Every card always shows the current price. Cost on the Blaze
// plan: ~22 reads per page load, 1 read per open tab per bid (see CLAUDE.md).
export const useAuctionStore = defineStore('auction', () => {
  const auth = useAuthStore()

  const items = shallowRef([]) // item docs in lot order
  const settings = ref(null)
  const myBidItemIds = shallowRef(new Set())
  const loaded = ref(false)
  const error = ref('')

  const itemsById = computed(() => new Map(items.value.map((it) => [it.id, it])))

  const onError = (e) => {
    console.error('Firestore listener failed', e)
    error.value = {
      'resource-exhausted': 'The auction is temporarily over capacity. Please try again later.',
      // The rules refuse this user everything: the admin's emergency stop is on.
      'permission-denied': 'The auction is temporarily unavailable. Try reloading in a few minutes.',
    }[e.code] ?? 'Lost connection to the auction. Reload the page to retry.'
  }

  let unsubs = []

  function attach(uid) {
    detach()
    unsubs = [
      subscribeSettings(db, (s) => (settings.value = s), onError),
      subscribeItems(db, (list) => {
        items.value = list
        loaded.value = true
        error.value = ''
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
    items.value = []
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

  // Optimistically mark an item as bid on (the listener confirms shortly after).
  function noteOwnBid(itemId) {
    if (!myBidItemIds.value.has(itemId)) myBidItemIds.value = new Set([...myBidItemIds.value, itemId])
  }

  // For the header indicator: 'live' | 'connecting'.
  const connection = computed(() => (loaded.value ? 'live' : 'connecting'))

  return { items, itemsById, settings, myBidItemIds, loaded, error, connection, init, noteOwnBid }
})
