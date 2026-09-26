// Reconnect schedule after Firestore refuses or drops the page's live data (e.g.
// the admin's emergency stop, an App Check hiccup): 5 s, 15 s, then every 60 s.
// During an emergency stop that's at most one refused attempt a minute per page.
const RETRY_MS = [5_000, 15_000, 60_000]

export const retryDelay = (attempt) => RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]
