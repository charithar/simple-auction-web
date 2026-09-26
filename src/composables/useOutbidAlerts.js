import { ref, watch } from 'vue'
import { formatMoney } from '../lib/auction.js'
import { standings, newlyOutbid } from '../lib/myBids.js'

const TOAST_MS = 10_000

export const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window

// Alerts while the page is open when an item goes from "winning" to "outbid":
// a toast, plus a browser notification if the tab is in the background and the
// bidder allowed notifications (BidDialog offers it after a bid). No backend.
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
    if (document.visibilityState === 'hidden' && notificationsSupported() && Notification.permission === 'granted') {
      const n = new Notification('You were outbid', { body: text, tag: item.id })
      n.onclick = () => {
        window.focus()
        openItem(item.id)
        n.close()
      }
    }
  }

  watch(rows, (list) => {
    if (!list.length) return // not loaded yet: no baseline
    if (before) newlyOutbid(before, list).forEach(alert)
    before = standings(list)
  })

  return { toasts, dismiss }
}
