import { ref, watch } from 'vue'
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
export function useOutbidAlerts(rows, openItem) {
  const toasts = ref([]) // [{ id, itemId, text }]
  let before = null
  let seq = 0

  const dismiss = (id) => (toasts.value = toasts.value.filter((t) => t.id !== id))

  function alert(item) {
    const text = `Outbid on ${item.title}: the price is now ${formatMoney(item.currency, item.currentAmount)}.`
    const id = ++seq
    toasts.value = [...toasts.value.filter((t) => t.itemId !== item.id), { id, itemId: item.id, text }]
    setTimeout(() => dismiss(id), TOAST_MS)
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
