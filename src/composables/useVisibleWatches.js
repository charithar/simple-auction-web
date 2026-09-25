// Live prices only for cards on (or near) the screen: an IntersectionObserver
// holds a 'visible' watch in the auction store for each such card (see
// stores/auction.js). Each card registers once, so reconcile() re-checks that
// the store still watches every card we hold a watch for, re-watches any it
// lost track of, watches on-screen cards the observer never reported (checked
// by position, so it doesn't depend on the observer firing), then lets the
// store repair stuck listeners. HomeView runs it every few seconds and when
// the tab becomes visible.
//
// auction: { watchItem, isWatching, checkWatches, debugState } (the store).
// Observer, isOnScreen, isHidden and log are injectable for tests.
const MARGIN_PX = 400 // start loading a little before a card scrolls in

const defaultIsOnScreen = (el) => {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.bottom > -MARGIN_PX && r.top < window.innerHeight + MARGIN_PX
}

export function useVisibleWatches(auction, {
  Observer = globalThis.IntersectionObserver,
  isOnScreen = defaultIsOnScreen,
  isHidden = () => document.visibilityState === 'hidden',
  log = (...args) => console.warn(...args),
} = {}) {
  const releases = new Map() // element -> release()
  const observed = new Set() // every card element
  const suspects = new Set() // on screen but unreported at the last reconcile

  const observer = new Observer(
    (entries) => {
      for (const e of entries) {
        const id = e.target.dataset.itemId
        if (e.isIntersecting && !releases.has(e.target)) releases.set(e.target, auction.watchItem(id, 'visible'))
        if (!e.isIntersecting && releases.has(e.target)) {
          releases.get(e.target)()
          releases.delete(e.target)
        }
      }
    },
    { rootMargin: `${MARGIN_PX}px 0px` },
  )

  const vWatchVisible = {
    mounted(el, { value }) {
      el.dataset.itemId = value
      observed.add(el)
      observer.observe(el)
    },
    unmounted(el) {
      observer.unobserve(el)
      observed.delete(el)
      suspects.delete(el)
      releases.get(el)?.()
      releases.delete(el)
    },
  }

  function reconcile() {
    const lost = []
    for (const el of releases.keys()) {
      const id = el.dataset.itemId
      if (auction.isWatching(id, 'visible')) continue
      // The store no longer counts this card. Its old release() would now
      // subtract from someone else's count, so it's dropped, not called.
      lost.push(id)
      releases.set(el, auction.watchItem(id, 'visible'))
    }
    if (lost.length) {
      log(`[auction] ${lost.length} on-screen item(s) had no watch, re-watching: ${lost.join(', ')} [${auction.debugState()}]`)
    }
    // Cards on screen that the observer never reported. Only after two checks in
    // a row, since a card that just scrolled in may not be reported yet. Not in
    // a hidden tab: there the observer rightly waits until the tab is shown.
    const unseen = []
    for (const el of observed) {
      if (releases.has(el) || isHidden() || !isOnScreen(el)) {
        suspects.delete(el)
      } else if (!suspects.has(el)) {
        suspects.add(el)
      } else {
        suspects.delete(el)
        const id = el.dataset.itemId
        unseen.push(id)
        releases.set(el, auction.watchItem(id, 'visible'))
      }
    }
    if (unseen.length) {
      log(`[auction] ${unseen.length} on-screen card(s) never reported by the observer, watching: ${unseen.join(', ')} [${auction.debugState()}]`)
    }
    auction.checkWatches()
    return { lost, unseen }
  }

  function stop() {
    observer.disconnect()
    releases.forEach((release) => release())
    releases.clear()
    observed.clear()
    suspects.clear()
  }

  return { vWatchVisible, reconcile, stop }
}
