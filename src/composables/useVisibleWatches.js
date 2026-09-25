// Live prices only for cards on (or near) the screen: an IntersectionObserver
// holds a 'visible' watch in the auction store for each such card (see
// stores/auction.js). Each card registers once, so reconcile() re-checks that
// the store still watches every card we hold a watch for, re-watches any it
// lost track of, then lets the store repair stuck listeners. HomeView runs it
// every few seconds and when the tab becomes visible.
//
// auction: { watchItem, isWatching, checkWatches, debugState } (the store).
// Observer / log are injectable for tests.
export function useVisibleWatches(auction, {
  Observer = globalThis.IntersectionObserver,
  rootMargin = '400px 0px', // start loading a little before a card scrolls in
  log = (...args) => console.warn(...args),
} = {}) {
  const releases = new Map() // element -> release()

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
    { rootMargin },
  )

  const vWatchVisible = {
    mounted(el, { value }) {
      el.dataset.itemId = value
      observer.observe(el)
    },
    unmounted(el) {
      observer.unobserve(el)
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
    auction.checkWatches()
    return lost
  }

  function stop() {
    observer.disconnect()
    releases.forEach((release) => release())
    releases.clear()
  }

  return { vWatchVisible, reconcile, stop }
}
