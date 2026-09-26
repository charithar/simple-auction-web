<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { db } from '../firebase.js'
import { formatMoney, increments } from '../lib/auction.js'
import { placeBid, bidErrorMessage, BidError, outbidNotice } from '../lib/bids.js'
import { viewFor, initialBidText } from '../lib/itemView.js'
import { useAuctionStore } from '../stores/auction.js'
import { useAuthStore } from '../stores/auth.js'
import { useOnline } from '../composables/useOnline.js'
import { notificationsSupported, showTestNotification } from '../composables/useOutbidAlerts.js'
import ItemImage from './ItemImage.vue'
import StandingBadge from './StandingBadge.vue'
import TimeLeft from './TimeLeft.vue'

const props = defineProps({
  itemId: { type: String, default: null },
  now: { type: Number, required: true },
})
const emit = defineEmits(['close'])

const auction = useAuctionStore()
const auth = useAuthStore()

const dialog = ref(null)
const imageIndex = ref(0)
const amountText = ref('')
const submitting = ref(false)
const message = ref(null) // { kind: 'error' | 'success', text }
// "Bid placed" goes stale when someone else takes the lead while the dialog is
// open: show that the bidder has been outbid instead (live price and minimum).
const shownMessage = computed(() => {
  const it = item.value
  if (message.value?.kind === 'success' && it?.highBidderUid != null && it.highBidderUid !== auth.user?.uid) {
    return { kind: 'error', text: outbidNotice(it, auction.settings) }
  }
  return message.value
})

const item = computed(() => (props.itemId ? auction.itemsById.get(props.itemId) : null))
const view = computed(() =>
  item.value && auction.settings
    ? viewFor(item.value, {
        settings: auction.settings,
        uid: auth.user?.uid,
        myBidItemIds: auction.myBidItemIds,
        now: props.now,
      })
    : null,
)
const step = computed(() => (item.value ? increments(item.value, auction.settings).min : 0))
const amount = computed(() => (/^\d+$/.test(amountText.value.trim()) ? Number(amountText.value.trim()) : null))
const quickAmounts = computed(() => {
  if (!view.value) return []
  const list = [0, 1, 2].map((k) => view.value.minBid + k * step.value)
  return list.filter((a) => view.value.maxBid == null || a <= view.value.maxBid)
})
const amountProblem = computed(() => {
  if (!view.value || amountText.value.trim() === '') return ''
  if (amount.value == null) return 'Enter a whole number.'
  if (amount.value < view.value.minBid) return `Minimum bid is ${money(view.value.minBid)}.`
  if (view.value.maxBid != null && amount.value > view.value.maxBid) return `Maximum bid is ${money(view.value.maxBid)}.`
  return ''
})
const online = useOnline()
const canSubmit = computed(() =>
  online.value && view.value?.canBid && amount.value != null && !amountProblem.value && !submitting.value)

const money = (v) => formatMoney(item.value?.currency, v)

watch(
  () => props.itemId,
  async (id) => {
    message.value = null
    notifyNote.value = ''
    imageIndex.value = 0
    if (id) {
      amountText.value = initialBidText(view.value)
      await nextTick()
      if (!dialog.value.open) dialog.value.showModal()
    } else if (dialog.value?.open) {
      dialog.value.close()
    }
  },
)

// Someone else bid while the dialog is open: raise a now-too-low suggestion.
watch(
  () => view.value?.minBid,
  (min, old) => {
    if (min == null) return
    // First data after opening: prefill. Later: raise a now-too-low amount.
    if (old == null ? amountText.value === '' : min !== old && (amount.value == null || amount.value < min)) {
      amountText.value = String(min)
    }
  },
)

// The native "close" event arrives a moment after the dialog closes. If another
// item was opened in between, the dialog is open again: ignore the late event,
// or it would close the new item too.
function onClose() {
  if (!dialog.value.open) emit('close')
}

// After a bid: offer a browser notification for when this bidder is outbid while
// the tab is in the background (HomeView's useOutbidAlerts sends it).
const canAskNotify = ref(false)
const notifyNote = ref('')
async function askNotify() {
  canAskNotify.value = false
  const permission = await Notification.requestPermission()
  notifyNote.value = permission === 'granted' && showTestNotification()
    ? "Outbid alerts are on: we just sent a sample. Didn't see it? Allow notifications for your browser in your computer's settings and turn off Do not disturb."
    : "Notifications are blocked for this site. To turn them on later, use the icon left of the address bar."
}

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  message.value = null
  const bidAmount = amount.value
  try {
    const placed = await placeBid(db, {
      itemId: item.value.id,
      uid: auth.user.uid,
      amount: bidAmount,
      settings: auction.settings,
      // Fresh server-time estimate: the 1 s countdown ticker can lag a close.
      now: Date.now() + auth.clockOffsetMs,
      seenBidCount: item.value.bidCount,
    })
    auction.noteOwnBid(item.value.id, placed)
    message.value = { kind: 'success', text: `Bid placed: you're the highest bidder at ${money(bidAmount)}.` }
    canAskNotify.value = notificationsSupported() && Notification.permission === 'default'
  } catch (e) {
    if (!(e instanceof BidError)) console.error('Bid failed', e)
    message.value = { kind: 'error', text: bidErrorMessage(e) }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <dialog
    ref="dialog"
    class="m-auto w-[calc(100%-1rem)] max-w-3xl rounded-xl p-0 shadow-2xl backdrop:bg-slate-900/60"
    @close="onClose"
    @click.self="dialog.close()"
  >
    <div v-if="item && view" class="grid max-h-[92dvh] grid-cols-1 overflow-y-auto md:grid-cols-2">
      <!-- Images: compact on phones so the bid form stays above the fold -->
      <div class="min-w-0 border-b border-slate-100 md:border-r md:border-b-0">
        <div class="mx-auto w-40 md:w-auto">
          <ItemImage :src="item.images?.[imageIndex]" :alt="item.title" eager />
        </div>
        <div v-if="item.images?.length > 1" class="flex gap-2 p-2">
          <button
            v-for="(src, i) in item.images"
            :key="src"
            type="button"
            :class="i === imageIndex ? 'ring-2 ring-sky-500' : 'ring-1 ring-slate-200'"
            class="w-14 overflow-hidden rounded"
            @click="imageIndex = i"
          >
            <ItemImage :src="src" :alt="`${item.title} image ${i + 1}`" />
          </button>
        </div>
      </div>

      <!-- Details + bid form -->
      <div class="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-xs text-slate-400">Lot {{ item.order }}<template v-if="item.category"> · {{ item.category }}</template></div>
            <h2 class="text-xl font-semibold">{{ item.title }}</h2>
            <p v-if="item.subtitle" class="text-sm text-slate-500">{{ item.subtitle }}</p>
          </div>
          <button type="button" class="-m-1 rounded p-1 text-slate-400 hover:text-slate-700" aria-label="Close" @click="dialog.close()">
            <svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <StandingBadge :standing="view.standing" />
          <span
            v-if="item.condition"
            :class="item.condition === 'Used' ? 'bg-slate-100 text-slate-700' : 'bg-amber-100 text-amber-800'"
            class="rounded-full px-2.5 py-0.5 text-xs font-medium"
          >
            {{ item.condition }}
          </span>
        </div>

        <div class="rounded-lg bg-slate-50 p-4">
          <div class="flex items-end justify-between gap-2">
            <div>
              <div class="text-xs text-slate-500">{{ item.bidCount === 0 ? 'Starting price' : 'Current bid' }}</div>
              <div class="text-2xl font-bold tabular-nums">{{ money(item.currentAmount) }}</div>
              <div class="text-xs text-slate-500">{{ item.bidCount }} bid{{ item.bidCount === 1 ? '' : 's' }}</div>
            </div>
            <TimeLeft :view="view" class="text-right text-sm" />
          </div>

          <form v-if="view.canBid" class="mt-4 flex flex-col gap-2" @submit.prevent="submit">
            <label for="bid-amount" class="text-sm font-medium">Your bid ({{ item.currency }})</label>
            <div class="flex gap-2">
              <input
                id="bid-amount"
                v-model="amountText"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                :aria-invalid="!!amountProblem"
                class="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-lg tabular-nums focus:border-sky-500 focus:ring-2 focus:ring-sky-200 focus:outline-none aria-invalid:border-rose-500"
              />
              <button
                type="submit"
                :disabled="!canSubmit"
                class="rounded-md bg-sky-600 px-4 py-2 font-semibold whitespace-nowrap text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {{ submitting ? 'Placing…' : amount != null && !amountProblem ? `Bid ${money(amount)}` : 'Bid' }}
              </button>
            </div>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="a in quickAmounts"
                :key="a"
                type="button"
                class="rounded-full border border-slate-300 bg-white px-3 py-1 text-sm tabular-nums hover:border-sky-500"
                @click="amountText = String(a)"
              >
                {{ money(a) }}
              </button>
            </div>
            <p class="text-xs text-slate-500">
              Minimum {{ money(view.minBid) }}<template v-if="view.maxBid != null">, maximum {{ money(view.maxBid) }}</template>.
              Bids in the last {{ Math.round(auction.settings.antiSnipeSeconds / 60) }} min extend the closing time.
            </p>
            <p v-if="amountProblem" class="text-sm text-rose-600">{{ amountProblem }}</p>
            <p v-if="!online" class="text-sm text-amber-800">You're offline. Reconnect to place a bid.</p>
          </form>
          <p v-else class="mt-3 text-sm text-slate-600">
            {{ view.ended ? 'Bidding on this item has closed.' : 'Bidding is currently closed.' }}
          </p>

          <p
            v-if="shownMessage"
            role="status"
            :class="shownMessage.kind === 'error' ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'"
            class="mt-3 rounded-md px-3 py-2 text-sm"
          >
            {{ shownMessage.text }}
          </p>
          <button
            v-if="shownMessage?.kind === 'success' && canAskNotify"
            type="button"
            class="mt-2 text-sm font-medium text-sky-700 underline-offset-2 hover:underline"
            @click="askNotify"
          >
            Notify me if I'm outbid while I'm in another tab or app
          </button>
          <p v-if="notifyNote" class="mt-2 text-xs text-slate-600" role="status">{{ notifyNote }}</p>
        </div>

        <dl v-if="item.specs?.length" class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <template v-for="s in item.specs" :key="s.name">
            <dt class="text-slate-500">{{ s.name }}</dt>
            <dd>{{ s.value }}</dd>
          </template>
        </dl>
        <p v-if="item.detail" class="text-sm whitespace-pre-line text-slate-600">{{ item.detail }}</p>
      </div>
    </div>
  </dialog>
</template>
