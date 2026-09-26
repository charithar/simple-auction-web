import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { useOutbidAlerts, notificationsSupported, showTestNotification } from '../../src/composables/useOutbidAlerts.js'

// Grid rows as HomeView builds them: [{ item, view: { standing } }].
// Someone else ('rival') leads unless the test says otherwise.
const item = (id, currentAmount = 5000, highBidderUid = 'rival') => ({ id, title: `Lot ${id}`, currency: 'Rs.', currentAmount, highBidderUid })
const row = (it, standing) => ({ item: it, view: { standing } })

// Browser notification double: records what was shown.
class FakeNotification {
  static permission = 'granted'
  static shown = []
  constructor(title, options) {
    this.title = title
    this.options = options
    this.close = vi.fn()
    FakeNotification.shown.push(this)
  }
}

let doc
beforeEach(() => {
  vi.useFakeTimers()
  FakeNotification.permission = 'granted'
  FakeNotification.shown = []
  doc = { visibilityState: 'visible', focused: true, hasFocus: () => doc.focused }
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', { Notification: FakeNotification, focus: vi.fn() })
  vi.stubGlobal('Notification', FakeNotification)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// Like HomeView: the grid starts empty and `initial` is the first data, which
// becomes the baseline.
async function setup(initial) {
  const rows = ref([])
  const openItem = vi.fn()
  const alerts = useOutbidAlerts(rows, openItem)
  const set = async (list) => {
    rows.value = list
    await nextTick()
  }
  await set(initial)
  return { rows, openItem, set, ...alerts }
}

describe('useOutbidAlerts', () => {
  it('no alert on the first data (items already outbid when the page opens)', async () => {
    const { toasts, set } = await setup([])
    await set([row(item('a'), 'outbid')])
    expect(toasts.value).toEqual([])
  })

  it('winning → outbid shows a toast with the new price', async () => {
    const { toasts, set } = await setup([row(item('a'), 'winning')])
    await set([row(item('a', 5250), 'outbid')])
    expect(toasts.value).toEqual([{ id: 1, itemId: 'a', text: 'Outbid on Lot a: the price is now Rs. 5,250.' }])
  })

  it('a newer alert for the same item replaces the older toast', async () => {
    const { toasts, set } = await setup([row(item('a'), 'winning')])
    await set([row(item('a', 5250), 'outbid')])
    await set([row(item('a', 5500), 'winning')])
    await set([row(item('a', 5750), 'outbid')])
    expect(toasts.value.map((t) => t.text)).toEqual(['Outbid on Lot a: the price is now Rs. 5,750.'])
  })

  it('toasts disappear after 10 s, or when dismissed', async () => {
    const { toasts, set, dismiss } = await setup([row(item('a'), 'winning'), row(item('b'), 'winning')])
    await set([row(item('a'), 'outbid'), row(item('b'), 'winning')])
    vi.advanceTimersByTime(5_000)
    await set([row(item('a'), 'outbid'), row(item('b'), 'outbid')])
    expect(toasts.value.map((t) => t.itemId)).toEqual(['a', 'b'])
    dismiss(toasts.value[1].id)
    expect(toasts.value.map((t) => t.itemId)).toEqual(['a'])
    vi.advanceTimersByTime(5_000)
    expect(toasts.value).toEqual([])
  })

  it('no alert when still winning, when the item ends, or for items never led', async () => {
    const { toasts, set } = await setup([row(item('a'), 'winning'), row(item('b'), 'outbid'), row(item('c'), null)])
    await set([row(item('a'), 'won'), row(item('b'), 'outbid'), row(item('c'), 'outbid')])
    expect(toasts.value).toEqual([])
  })

  it('in a background tab with permission: a browser notification that opens the item', async () => {
    const { set, openItem } = await setup([row(item('a'), 'winning')])
    doc.visibilityState = 'hidden'
    await set([row(item('a', 5250), 'outbid')])
    expect(FakeNotification.shown).toHaveLength(1)
    const n = FakeNotification.shown[0]
    expect(n.title).toBe('You were outbid')
    expect(n.options).toEqual({ body: 'Outbid on Lot a: the price is now Rs. 5,250.', tag: 'a' })
    n.onclick()
    expect(window.focus).toHaveBeenCalled()
    expect(openItem).toHaveBeenCalledWith('a')
    expect(n.close).toHaveBeenCalled()
  })

  it('a browser notification also when the tab is visible but another window is in front', async () => {
    const { set } = await setup([row(item('a'), 'winning')])
    doc.focused = false
    await set([row(item('a'), 'outbid')])
    expect(FakeNotification.shown.map((n) => n.title)).toEqual(['You were outbid'])
  })

  it('no browser notification while the tab is visible and focused, or without permission', async () => {
    const { set } = await setup([row(item('a'), 'winning'), row(item('b'), 'winning')])
    await set([row(item('a'), 'outbid'), row(item('b'), 'winning')]) // visible
    doc.visibilityState = 'hidden'
    FakeNotification.permission = 'default'
    await set([row(item('a'), 'outbid'), row(item('b'), 'outbid')]) // hidden, not allowed
    expect(FakeNotification.shown).toEqual([])
  })
})

describe('useOutbidAlerts: no false alerts', () => {
  it('no alert when an admin reset leaves the item without a leader', async () => {
    const { set, toasts } = await setup([row(item('a'), 'winning')])
    await set([row(item('a', 5000, null), 'outbid')]) // bids reset; own bid not yet gone from "my bids"
    expect(toasts.value).toEqual([])
  })

  it('signing out forgets the standings: the next user (or the same one) starts fresh', async () => {
    const { set, toasts } = await setup([row(item('a'), 'winning')])
    await set([]) // signed out
    await set([row(item('a'), 'outbid')]) // signed back in, outbid meanwhile
    expect(toasts.value).toEqual([])
  })
})

describe('notificationsSupported', () => {
  it('only where the browser has the Notification API', () => {
    expect(notificationsSupported()).toBe(true)
    vi.stubGlobal('window', {})
    expect(notificationsSupported()).toBe(false)
    vi.stubGlobal('window', undefined)
    expect(notificationsSupported()).toBe(false)
  })
})

describe('showTestNotification', () => {
  it('sends a sample right after notifications are allowed', () => {
    expect(showTestNotification()).toBe(true)
    expect(FakeNotification.shown.map((n) => [n.title, n.options.tag])).toEqual([['Outbid alerts are on', 'auction-test']])
  })

  it('sends nothing without permission or without the Notification API', () => {
    FakeNotification.permission = 'denied'
    expect(showTestNotification()).toBe(false)
    vi.stubGlobal('window', {})
    FakeNotification.permission = 'granted'
    expect(showTestNotification()).toBe(false)
    expect(FakeNotification.shown).toEqual([])
  })
})
