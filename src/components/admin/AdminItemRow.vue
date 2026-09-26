<script setup>
import { ref, computed, watch } from 'vue'
import { db } from '../../firebase.js'
import { extendItem, resetItemBids, fetchItemBids, setItemEnd, endItemIn } from '../../lib/admin.js'
import { formatMoney } from '../../lib/auction.js'
import TimeLeft from '../TimeLeft.vue'
import ConfirmButton from './ConfirmButton.vue'

const props = defineProps({
  item: { type: Object, required: true },
  view: { type: Object, required: true },
  settings: { type: Object, required: true },
  now: { type: Number, required: true },
  lookupUser: { type: Function, required: true },
})

const open = ref(false)
const busy = ref(false)
const error = ref('')
const bids = ref(null)
const bidders = ref(new Map())
const highBidder = ref(null)
const endInput = ref('')

watch(
  () => props.item.highBidderUid,
  async (uid) => (highBidder.value = uid ? await props.lookupUser(uid) : null),
  { immediate: true },
)

// Reload history when the row is open and a new bid arrives.
watch([open, () => props.item.bidCount], async ([isOpen]) => {
  if (!isOpen) return
  try {
    const list = await fetchItemBids(db, props.item.id)
    const users = await Promise.all([...new Set(list.map((b) => b.uid))].map(async (uid) => [uid, await props.lookupUser(uid)]))
    bidders.value = new Map(users)
    bids.value = list
  } catch (e) {
    console.error(e)
    error.value = 'Could not load bids.'
  }
})

// Keep the closing-time field in sync with the live end (e.g. after +5m or a
// late bid), unless the admin is editing it, so "Set" never reverts a change.
const endField = ref(null)
watch([open, () => props.view.end], ([isOpen]) => {
  if (isOpen && document.activeElement !== endField.value) endInput.value = toLocalInput(new Date(props.view.end))
})

const money = (v) => formatMoney(props.item.currency, v)
const endLabel = computed(() => new Date(props.view.end).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))

async function run(fn) {
  busy.value = true
  error.value = ''
  try {
    await fn()
  } catch (e) {
    console.error(e)
    error.value = e.message?.startsWith('Pause') ? e.message : 'Action failed. See console for details.'
  } finally {
    busy.value = false
  }
}

const extend = (min) => run(() => extendItem(db, props.item, props.settings, min * 60_000, props.now))
const endSoon = () => run(() => endItemIn(db, props.item.id, 2 * 60_000, props.now))
const reset = () => run(async () => {
  await resetItemBids(db, props.item, props.settings)
  bids.value = []
})
const saveEnd = () => run(() => setItemEnd(db, props.item.id, new Date(endInput.value)))

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <tr class="border-t border-slate-100 align-top" :class="{ 'bg-slate-50': open }">
    <td class="px-3 py-2 text-slate-500 tabular-nums">{{ item.order }}</td>
    <td class="px-3 py-2">
      <button type="button" class="text-left font-medium hover:text-sky-700" :aria-expanded="open" @click="open = !open">
        <span class="mr-1 inline-block w-3 text-slate-400">{{ open ? '▾' : '▸' }}</span>{{ item.title }}
      </button>
      <div class="pl-4 text-xs text-slate-500">{{ item.subtitle }}</div>
    </td>
    <td class="px-3 py-2 text-right font-semibold whitespace-nowrap tabular-nums">{{ money(item.currentAmount) }}</td>
    <td class="px-3 py-2 text-right tabular-nums">{{ item.bidCount }}</td>
    <td class="px-3 py-2">
      <template v-if="item.highBidderUid">
        <div class="font-medium">{{ highBidder?.name ?? '…' }}</div>
        <div class="text-xs text-slate-500">{{ highBidder?.email }}</div>
      </template>
      <span v-else class="text-slate-400">No bids</span>
    </td>
    <td class="px-3 py-2 whitespace-nowrap">
      <TimeLeft :view="view" class="text-sm" />
      <div class="text-xs text-slate-500">{{ endLabel }}</div>
    </td>
    <td class="px-3 py-2">
      <div class="flex flex-wrap gap-1">
        <button type="button" :disabled="busy" class="rounded-md bg-white px-2 py-1 text-sm ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-40" @click="extend(5)">+5m</button>
        <button type="button" :disabled="busy" class="rounded-md bg-white px-2 py-1 text-sm ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-40" @click="extend(15)">+15m</button>
        <ConfirmButton
          :disabled="busy || view.ended"
          title="Close this item 2 minutes from now (e.g. to try anti-sniping)"
          confirm-label="End in 2 min?"
          @confirm="endSoon"
        >
          End in 2m
        </ConfirmButton>
        <ConfirmButton
          :disabled="busy || item.bidCount === 0 || settings.biddingOpen"
          :title="settings.biddingOpen ? 'Pause bidding first' : ''"
          :confirm-label="`Delete ${item.bidCount} bid(s)?`"
          @confirm="reset"
        >
          Reset
        </ConfirmButton>
      </div>
      <p v-if="error" class="mt-1 text-xs text-rose-700">{{ error }}</p>
    </td>
  </tr>
  <tr v-if="open" class="bg-slate-50">
    <td></td>
    <td colspan="6" class="px-3 pb-4">
      <div class="grid gap-4 md:grid-cols-[1fr_auto]">
        <div>
          <h3 class="text-sm font-semibold">Bid history</h3>
          <p v-if="bids === null" class="text-sm text-slate-500">Loading…</p>
          <p v-else-if="bids.length === 0" class="text-sm text-slate-500">No bids yet.</p>
          <table v-else class="mt-1 text-sm">
            <tr v-for="b in bids" :key="b.n" class="border-t border-slate-200">
              <td class="py-1 pr-4 text-slate-500 tabular-nums">#{{ b.n }}</td>
              <td class="py-1 pr-4 font-medium tabular-nums">{{ money(b.amount) }}</td>
              <td class="py-1 pr-4">{{ bidders.get(b.uid)?.name ?? b.uid }} <span class="text-slate-500">{{ bidders.get(b.uid)?.email }}</span></td>
              <td class="py-1 text-slate-500">{{ b.createdAt?.toDate().toLocaleTimeString() }}</td>
            </tr>
          </table>
        </div>
        <form class="flex flex-col gap-1 text-sm" @submit.prevent="saveEnd">
          <label :for="`end-${item.id}`" class="font-semibold">Closing time</label>
          <div class="flex gap-2">
            <input :id="`end-${item.id}`" ref="endField" v-model="endInput" type="datetime-local" required class="rounded-md border border-slate-300 px-2 py-1" />
            <button type="submit" :disabled="busy" class="rounded-md bg-slate-800 px-3 py-1 text-white disabled:opacity-40">Set</button>
          </div>
          <p class="max-w-64 text-xs text-slate-500">Anti-sniping can still extend it by {{ settings.antiSnipeSeconds }}s after a late bid.</p>
        </form>
      </div>
    </td>
  </tr>
</template>
