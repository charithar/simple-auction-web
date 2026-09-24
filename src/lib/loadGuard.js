// Protects the free read quota from rapid page reloads. Every full page load
// re-listens to Firestore (~15 reads if the server can't resume), so repeated
// refreshing is the cheapest way for one person to burn the daily quota.
// Loads are recorded in localStorage (shared by all tabs of the browser); from
// the 3rd load within a minute, the app shows cached data and delays going live.

const KEY = 'auction.loads'
const WINDOW_MS = 60_000
const STEPS_MS = [0, 0, 15_000, 30_000, 60_000] // by number of loads in the window (incl. this one)

// Pure: cooldown for a page load at `now`, given earlier load times.
export function cooldownFor(previousLoads, now) {
  const recent = previousLoads.filter((t) => now - t < WINDOW_MS).length + 1
  return STEPS_MS[Math.min(recent, STEPS_MS.length) - 1]
}

// Records this page load and returns { cooldownMs }.
export function registerPageLoad(now = Date.now(), storage = safeStorage()) {
  let loads
  try {
    loads = JSON.parse(storage?.getItem(KEY) ?? '[]').filter((t) => typeof t === 'number' && now - t < 10 * WINDOW_MS)
  } catch {
    loads = []
  }
  const cooldownMs = cooldownFor(loads, now)
  try {
    storage?.setItem(KEY, JSON.stringify([...loads, now].slice(-20)))
  } catch {
    /* storage full or blocked: no guard, app still works */
  }
  return { cooldownMs }
}

// ---- small per-user cache for things that don't need re-checking every load ----

export function readCached(key, maxAgeMs, now = Date.now(), storage = safeStorage()) {
  try {
    const v = JSON.parse(storage?.getItem(key) ?? 'null')
    return v && now - v.at < maxAgeMs ? v.data : null
  } catch {
    return null
  }
}

export function writeCached(key, data, now = Date.now(), storage = safeStorage()) {
  try {
    storage?.setItem(key, JSON.stringify({ at: now, data }))
  } catch {
    /* ignore */
  }
}

export function clearCached(key, storage = safeStorage()) {
  try {
    storage?.removeItem(key)
  } catch {
    /* ignore */
  }
}

function safeStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
