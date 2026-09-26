import { defineStore } from 'pinia'
import { ref, shallowRef, computed, watch } from 'vue'
import { db } from '../firebase.js'
import {
  subscribeCatalog, subscribeItem, subscribeSettings, subscribeMyBidItems,
  cachedCatalog, cachedItem, cachedSettings, cachedMyBidItems,
} from '../lib/items.js'
import { registerPageLoad } from '../lib/loadGuard.js'
import { findStuck } from '../lib/watchHealth.js'
import { effectiveEnd, toMillis } from '../lib/auction.js'
import { useAuthStore } from './auth.js'

// Read budget design (see CLAUDE.md):
// - catalog/items: display data for all items in ONE doc -> 1 read per page load.
// - items/{id}: live price/bids, listened to only while the item is visible,
//   bid on by this user, or open in the dialog. A bid then only costs reads
//   for the people actually looking at that item.
// - Everything detaches after the tab has been hidden for a while; the
//   persistent cache makes re-attaching within 30 minutes cheap.
// - Rapid reloads (lib/loadGuard.js): from the 3rd page load within a minute the
//   store first shows cached data and only goes live after a cooldown, so
//   refresh-spamming can't multiply reads.
const HIDDEN_GRACE_MS = 3 * 60_000
const LINGER_MS = 20_000 // keep a scrolled-away item live briefly to avoid churn
// Reasons that go live even during the reload cooldown: the item open in the bid
// dialog needs a current price and a bid form (one listener, and the bidder
// is about to bid). The grid's cards wait for the cooldown.
const LIVE_IN_COOLDOWN = ['open']

export const useAuctionStore = defineStore('auction', () => {
  const auth = useAuthStore()

  const catalog = shallowRef(null) // [{ id, order, title, ..., endTime }] or null (not set up)
  const live = shallowRef(new Map()) // id -> live item doc
  // id -> catalog endTime (ms) of items seen ended with live data. Such an item
  // can't reopen (the rules refuse every later bid) unless an admin moves its
  // closing time, which also changes the catalog endTime. Lets "Open" keep
  // hiding it after its listener detaches, instead of the card reappearing,
  // going live, being hidden and detaching again every 20 s.
  const confirmedEnded = shallowRef(new Map())
  const settings = ref(null)
  const myBidItemIds = shallowRef(new Set())
  const loaded = ref(false)
  const paused = ref(false)
  const error = ref('')

  // Reload cooldown for this page load (0 = go live immediately).
  const { cooldownMs } = registerPageLoad()
  const cooldownUntil = ref(cooldownMs ? Date.now() + cooldownMs : 0)
  const cooling = ref(cooldownMs > 0)
  let cooldownTimer = null

  // Catalog entries merged with live docs; `live` tells whether the price is current.
  const itemsById = computed(() => {
    const out = new Map()
    for (const c of catalog.value ?? []) {
      const l = live.value.get(c.id)
      out.set(c.id, l
        ? { ...c, ...l, live: true }
        : { ...c, live: false, confirmedEnded: confirmedEnded.value.get(c.id) === toMillis(c.endTime) })
    }
    return out
  })
  const items = computed(() => [...itemsById.value.values()])

  // ---- per-item watches ----
  const watches = new Map() // id -> { reasons: Map<reason, count>, unsub, lingerTimer, attachedAt, repairs }

  const onError = (e) => {
    console.error('Firestore listener failed', e)
    error.value = e.code === 'resource-exhausted'
      ? 'The auction is temporarily over capacity. Please try again later.'
      : 'Lost connection to the auction. Reload the page to retry.'
  }

  function setLive(id, doc) {
    const next = new Map(live.value)
    if (doc) next.set(id, doc)
    else next.delete(id)
    live.value = next
  }

  function attachItem(id, w) {
    if (w.unsub || paused.value || !auth.user) return
    if (cooling.value && !LIVE_IN_COOLDOWN.some((r) => w.reasons.has(r))) {
      // Cached copy only (free); the real listener attaches when the cooldown ends.
      cachedItem(db, id).then((doc) => {
        if (cooling.value && watches.has(id) && doc) setLive(id, doc)
      })
      return
    }
    w.attachedAt = Date.now()
    w.unsub = subscribeItem(db, id, (doc) => setLive(id, doc), onError)
  }

  function detachItem(id, w) {
    w.unsub?.()
    w.unsub = null
    w.attachedAt = null
    const doc = live.value.get(id)
    if (doc && settings.value && effectiveEnd(doc, settings.value) <= Date.now() + auth.clockOffsetMs) {
      confirmedEnded.value = new Map(confirmedEnded.value).set(id, toMillis(doc.endTime))
    }
    if (live.value.has(id)) {
      const next = new Map(live.value)
      next.delete(id)
      live.value = next
    }
  }

  // Returns a release function. Watches are reference-counted per reason.
  function watchItem(id, reason) {
    let w = watches.get(id)
    if (!w) watches.set(id, (w = { reasons: new Map(), unsub: null, lingerTimer: null, attachedAt: null, repairs: 0 }))
    w.reasons.set(reason, (w.reasons.get(reason) ?? 0) + 1)
    clearTimeout(w.lingerTimer)
    attachItem(id, w)
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (w.reasons.get(reason) ?? 1) - 1
      if (n > 0) w.reasons.set(reason, n)
      else w.reasons.delete(reason)
      if (w.reasons.size === 0) {
        w.lingerTimer = setTimeout(() => {
          if (w.reasons.size === 0) {
            detachItem(id, w)
            watches.delete(id)
          }
        }, LINGER_MS)
      }
    }
  }

  const isWatching = (id, reason) => watches.get(id)?.reasons.has(reason) ?? false

  // One line of store state for diagnostics in the console.
  const debugState = () =>
    `cooling=${cooling.value} paused=${paused.value} loaded=${loaded.value} signedIn=${!!auth.user} ` +
    `watches=${watches.size} live=${live.value.size}`

  // Safety net, run every few seconds by HomeView (useVisibleWatches): re-attaches
  // watched items that have no listener, or whose listener has delivered nothing
  // for 10 s. Skipped during the reload cooldown and while paused, where missing
  // live data is expected. Costs no reads unless something is actually repaired.
  function checkWatches(now = Date.now()) {
    if (cooling.value || paused.value || !auth.user) return []
    const stuck = findStuck(watches, live.value, now)
    for (const { id, problem } of stuck) {
      const w = watches.get(id)
      if (problem === 'no-data') {
        w.unsub?.()
        w.unsub = null
        w.repairs++
      }
      attachItem(id, w)
    }
    if (stuck.length) {
      const list = stuck.map(({ id, problem }) => `${id} (${problem}; ${[...watches.get(id).reasons.keys()].join('+')})`)
      console.warn(`[auction] repaired ${stuck.length} watched item(s): ${list.join(', ')} [${debugState()}]`)
    }
    return stuck
  }

  // Items the user bid on stay live (for winning/outbid badges and filters).
  const mineReleases = new Map()
  watch(myBidItemIds, (ids) => {
    for (const id of ids) if (!mineReleases.has(id)) mineReleases.set(id, watchItem(id, 'mine'))
    for (const [id, release] of mineReleases) {
      if (!ids.has(id)) {
        release()
        mineReleases.delete(id)
      }
    }
  })

  // ---- global listeners ----
  let globalUnsubs = []

  function attachAll(uid) {
    detachGlobals()
    paused.value = false
    if (cooling.value) {
      showCached(uid)
      clearTimeout(cooldownTimer)
      cooldownTimer = setTimeout(() => {
        cooling.value = false
        cooldownUntil.value = 0
        if (auth.user?.uid === uid && !paused.value) attachAll(uid)
      }, Math.max(0, cooldownUntil.value - Date.now()))
      return
    }
    globalUnsubs = [
      subscribeSettings(db, (s) => (settings.value = s), onError),
      subscribeCatalog(db, (list) => {
        catalog.value = list
        loaded.value = true
        error.value = ''
      }, onError),
      subscribeMyBidItems(db, uid, (ids) => (myBidItemIds.value = ids), onError),
    ]
    paused.value = false
    for (const [id, w] of watches) attachItem(id, w)
  }

  // During a reload cooldown: render whatever the local cache has (no reads).
  async function showCached(uid) {
    const [s, list, mine] = await Promise.all([cachedSettings(db), cachedCatalog(db), cachedMyBidItems(db, uid)])
    if (!cooling.value) return
    if (s) settings.value = s
    if (list) {
      catalog.value = list
      loaded.value = true
    }
    if (mine) myBidItemIds.value = mine
    for (const [id, w] of watches) attachItem(id, w)
  }

  function detachGlobals() {
    globalUnsubs.forEach((u) => u())
    globalUnsubs = []
  }

  function pauseAll() {
    detachGlobals()
    paused.value = true
    for (const [id, w] of watches) detachItem(id, w)
  }

  function reset() {
    detachGlobals()
    for (const [id, w] of watches) {
      clearTimeout(w.lingerTimer)
      detachItem(id, w)
    }
    watches.clear()
    mineReleases.clear()
    catalog.value = null
    live.value = new Map()
    confirmedEnded.value = new Map()
    settings.value = null
    myBidItemIds.value = new Set()
    loaded.value = false
    paused.value = false
    error.value = ''
  }

  let hiddenTimer = null
  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      clearTimeout(hiddenTimer)
      hiddenTimer = setTimeout(pauseAll, HIDDEN_GRACE_MS)
    } else {
      clearTimeout(hiddenTimer)
      if (paused.value && auth.user) attachAll(auth.user.uid)
    }
  }

  let started = false
  function init() {
    if (started) return
    started = true
    watch(
      () => auth.user?.uid,
      (uid) => (uid ? attachAll(uid) : reset()),
      { immediate: true },
    )
    document.addEventListener('visibilitychange', onVisibilityChange)
    // A tab opened in the background gets no visibilitychange until it's shown,
    // so start its hidden timer now.
    if (document.visibilityState === 'hidden') onVisibilityChange()
  }

  // Optimistically mark an item as bid on (the listener confirms shortly after).
  function noteOwnBid(itemId) {
    if (!myBidItemIds.value.has(itemId)) myBidItemIds.value = new Set([...myBidItemIds.value, itemId])
  }

  // For the header indicator: 'live' | 'cooldown' | 'paused' | 'connecting'.
  const connection = computed(() =>
    cooling.value ? 'cooldown' : paused.value ? 'paused' : loaded.value ? 'live' : 'connecting')

  return {
    catalog, items, itemsById, settings, myBidItemIds, loaded, paused, error, cooldownUntil, connection,
    init, watchItem, isWatching, checkWatches, debugState, noteOwnBid,
  }
})
