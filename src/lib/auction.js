// Pure auction logic shared by the UI and tests.
// Must stay in sync with firestore.rules (started / stillOpen / amountOk).

export const toMillis = (t) => {
  if (t == null) return null
  if (typeof t === 'number') return t
  if (t instanceof Date) return t.getTime()
  if (typeof t.toMillis === 'function') return t.toMillis()
  return null
}

// Raised minimum increment (settings.escalation, set on the admin page): while
// enabled, an item whose price is over `percent`% above its starting price needs
// `factor` times its minimum increment. A malformed setting raises nothing
// (firestore.rules escalated(), with the same bounds; NaN fails them too).
export const escalation = (settings) => {
  const e = settings.escalation
  const within = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi
  return e?.enabled === true && within(e.percent, 0, 10000) && within(e.factor, 1, 100) ? e : null
}

export const escalated = (item, settings) => {
  const e = escalation(settings)
  return e != null && typeof item.startingPrice === 'number'
    && item.currentAmount * 100 > item.startingPrice * (100 + e.percent)
}

// Capped at the maximum increment (else no bid would be valid), never below the
// normal one. Rounded up: a fractional factor typed in the console gives a
// fractional minimum, and the smallest whole bid above it is what the rules accept.
export const increments = (item, settings) => {
  const base = item.minIncrement ?? settings.minIncrement
  const max = item.maxIncrement ?? settings.maxIncrement ?? null
  if (!escalated(item, settings)) return { min: base, max }
  const raised = base * settings.escalation.factor
  return { min: Math.ceil(max == null || raised <= max ? raised : Math.max(max, base)), max }
}

// max(endTime, lastBidAt + antiSnipeSeconds)
export const effectiveEnd = (item, settings) => {
  const end = toMillis(item.endTime)
  const last = toMillis(item.lastBidAt)
  if (last == null) return end
  return Math.max(end, last + settings.antiSnipeSeconds * 1000)
}

// The optional global start (settings.startTime): ms, null when there is none, or
// NaN when it isn't a timestamp (e.g. text typed in the Firebase console): the rules
// can't compare that with request.time, so they refuse every bid (started()).
export const startOf = (settings) => {
  const t = settings.startTime
  if (t == null) return null
  if (t instanceof Date) return t.getTime()
  return typeof t.toMillis === 'function' ? t.toMillis() : NaN
}
export const startInvalid = (settings) => Number.isNaN(startOf(settings))

// Bidding refused for everyone: switched off, or a start time the rules can't use.
export const biddingClosed = (settings) => settings.biddingOpen !== true || startInvalid(settings)

// Switched on, but the start time hasn't come yet: bidding opens by itself then.
export const notStartedYet = (settings, now) => {
  const start = startOf(settings)
  return settings.biddingOpen === true && start != null && now < start
}

// Items that close at or before `start` (ms): they would never open. `endOf(item)`
// gives an item's closing time in ms. None when there is no (valid) start.
export const closingBeforeStart = (items, start, endOf) =>
  start == null || Number.isNaN(start) ? [] : items.filter((it) => endOf(it) <= start)

// "7:00 PM" today, else "Sat, Oct 3, 7:00 PM" (the viewer's locale and time zone).
export const formatStart = (ms, now) => {
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date(now).toDateString()
  return d.toLocaleString([], sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// A Date as the value of an <input type="datetime-local"> (local time, minutes).
export function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export const minNextBid = (item, settings) =>
  item.bidCount === 0 ? item.currentAmount : item.currentAmount + increments(item, settings).min

export const maxNextBid = (item, settings) => {
  const { max } = increments(item, settings)
  return max == null ? null : item.currentAmount + max
}

// Returns { ok: true } or { ok: false, code, message }.
export const validateBid = (item, settings, amount, now) => {
  if (biddingClosed(settings)) return fail('closed', 'Bidding is currently closed.')
  if (notStartedYet(settings, now)) {
    return fail('not-started', `Bidding hasn't started yet. It opens at ${formatStart(startOf(settings), now)}.`)
  }
  if (now >= effectiveEnd(item, settings)) return fail('ended', 'This item has ended.')
  if (!Number.isInteger(amount) || amount <= 0) return fail('invalid', 'Enter a whole number.')
  const min = minNextBid(item, settings)
  if (amount < min) return fail('too-low', `Minimum bid is ${formatMoney(item.currency, min)}.`)
  const max = maxNextBid(item, settings)
  if (max != null && amount > max) {
    return fail('too-high', `Maximum bid is ${formatMoney(item.currency, max)}.`)
  }
  return { ok: true }
}

const fail = (code, message) => ({ ok: false, code, message })

export const formatMoney = (currency, amount) =>
  `${currency ?? ''} ${Number(amount).toLocaleString('en-US')}`.trim()

// The anti-snipe window for bidders: "2 min" for whole minutes, else "30 s" / "90 s".
export const formatWindow = (seconds) => (seconds % 60 === 0 && seconds > 0 ? `${seconds / 60} min` : `${seconds} s`)

export const formatRemaining = (ms) => {
  if (ms <= 0) return 'Ended'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}
