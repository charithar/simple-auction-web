import { defineStore } from 'pinia'
import { ref, shallowRef, computed, watch } from 'vue'
import { db } from '../firebase.js'
import { subscribeItems, subscribeSettings, subscribeMyBidItems } from '../lib/items.js'
import { useAuthStore } from './auth.js'

// Detach listeners once the tab has been hidden this long. Shorter saves the
// per-bid fan-out reads; the persistent cache makes re-attaching within 30
// minutes cheap (only changed items are billed).
const HIDDEN_GRACE_MS = 3 * 60_000

export const useAuctionStore = defineStore('auction', () => {
  const auth = useAuthStore()

  const items = shallowRef([])
  const settings = ref(null)
  const myBidItemIds = shallowRef(new Set())
  const loaded = ref(false)
  const paused = ref(false)
  const error = ref('')

  const itemsById = computed(() => new Map(items.value.map((it) => [it.id, it])))

  let unsubs = []
  let hiddenTimer = null
  let started = false

  function attach(uid) {
    detach()
    const onError = (e) => {
      console.error('Firestore listener failed', e)
      error.value = e.code === 'resource-exhausted'
        ? 'The auction is temporarily over capacity. Please try again later.'
        : 'Lost connection to the auction. Reload the page to retry.'
    }
    unsubs = [
      subscribeSettings(db, (s) => (settings.value = s), onError),
      subscribeItems(db, (list) => {
        items.value = list
        loaded.value = true
        error.value = ''
      }, onError),
      subscribeMyBidItems(db, uid, (ids) => (myBidItemIds.value = ids), onError),
    ]
    paused.value = false
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

  function onVisibilityChange() {
    if (!auth.user) return
    if (document.visibilityState === 'hidden') {
      clearTimeout(hiddenTimer)
      hiddenTimer = setTimeout(() => {
        detach()
        paused.value = true
      }, HIDDEN_GRACE_MS)
    } else {
      clearTimeout(hiddenTimer)
      if (paused.value) attach(auth.user.uid)
    }
  }

  function init() {
    if (started) return
    started = true
    watch(
      () => auth.user?.uid,
      (uid) => (uid ? attach(uid) : reset()),
      { immediate: true },
    )
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  // Optimistically mark an item as bid on (the listener confirms shortly after).
  function noteOwnBid(itemId) {
    if (!myBidItemIds.value.has(itemId)) myBidItemIds.value = new Set([...myBidItemIds.value, itemId])
  }

  return { items, itemsById, settings, myBidItemIds, loaded, paused, error, init, noteOwnBid }
})
