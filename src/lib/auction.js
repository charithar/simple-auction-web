// Pure auction logic shared by the UI and tests.
// Must stay in sync with firestore.rules (started / stillOpen / amountOk).

export const toMillis = (t) => {
  if (t == null) return null
  if (typeof t === 'number') return t
  if (t instanceof Date) return t.getTime()
  if (typeof t.toMillis === 'function') return t.toMillis()
  return null
}

export const increments = (item, settings) => ({
  min: item.minIncrement ?? settings.minIncrement,
  max: item.maxIncrement ?? settings.maxIncrement ?? null,
})

// max(endTime, lastBidAt + antiSnipeSeconds)
export const effectiveEnd = (item, settings) => {
  const end = toMillis(item.endTime)
  const last = toMillis(item.lastBidAt)
  if (last == null) return end
  return Math.max(end, last + settings.antiSnipeSeconds * 1000)
}

// The optional global start (settings.startTime), in ms, or null.
export const startOf = (settings) => toMillis(settings.startTime)

// Switched on, but the start time hasn't come yet: bidding opens by itself then.
export const notStartedYet = (settings, now) => {
  const start = startOf(settings)
  return settings.biddingOpen === true && start != null && now < start
}

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
  if (!settings.biddingOpen) return fail('closed', 'Bidding is currently closed.')
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
