import { ref, watch, toValue } from 'vue'
import { formatMoney } from '../lib/auction.js'
import { standings, newlyOutbid } from '../lib/myBids.js'

const TOAST_MS = 10_000

export const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window

// The bidder isn't looking at the auction: the tab is hidden (another tab, a
// minimized window) or the browser window isn't focused (another app in front).
const notLooking = () => document.visibilityState === 'hidden' || !document.hasFocus()

// Shown right after the bidder allows notifications, so one that the operating
// system blocks (its notification settings, Do not disturb) is noticed now, not
// when it matters. Returns whether it was sent.
export function showTestNotification() {
  if (!notificationsSupported() || Notification.permission !== 'granted') return false
  return !!new Notification('Outbid alerts are on', {
    body: "You'll get a notification like this if you're outbid while the auction isn't in front.",
    tag: 'auction-test',
  })
}

// Alerts while the page is open when an item goes from "winning" to "outbid":
// a toast, plus a browser notification if the bidder isn't looking at the page
// (hidden tab, or another window in front) and allowed notifications (BidDialog
// offers it after a bid). No backend: the tab has to stay open.
// rows: computed grid rows ([{ item, view }]); openItem(id) opens the bid dialog.
// hold: a ref or getter, true while the bidder is busy in a dialog: toasts then
// stay (no 10 s countdown) and get a full 10 s once it closes, so "Bid again" isn't
// gone before they can use it.
export function useOutbidAlerts(rows, openItem, hold = () => false) {
  const toasts = ref([]) // [{ id, itemId, text }]
  const timers = new Map() // toast id → timeout
  let before = null
  let seq = 0

  const dismiss = (id) => {
    clearTimeout(timers.get(id))
    timers.delete(id)
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }
  const countDown = (id) => timers.set(id, setTimeout(() => dismiss(id), TOAST_MS))
  watch(hold, (holding) => {
    for (const t of toasts.value) {
      clearTimeout(timers.get(t.id))
      timers.delete(t.id)
      if (!holding) countDown(t.id)
    }
  })

  function alert(item) {
    const text = `Outbid on ${item.title}: the price is now ${formatMoney(item.currency, item.currentAmount)}.`
    const id = ++seq
    toasts.value.filter((t) => t.itemId === item.id).forEach((t) => dismiss(t.id))
    toasts.value = [...toasts.value, { id, itemId: item.id, text }]
    if (!toValue(hold)) countDown(id)
    if (notLooking() && notificationsSupported() && Notification.permission === 'granted') {
      const n = new Notification('You were outbid', { body: text, tag: item.id })
      n.onclick = () => {
        window.focus()
        openItem(item.id)
        n.close()
      }
    }
  }

  watch(rows, (list) => {
    if (!list.length) {
      before = null // signed out or not loaded yet: the next data is a fresh baseline
      return
    }
    if (before) newlyOutbid(before, list).forEach(alert)
    before = standings(list)
  })

  return { toasts, dismiss }
}
