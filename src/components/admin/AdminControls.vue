<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { db } from '../../firebase.js'
import { updateSettings, setKillSwitch, setStartTime, lotsText } from '../../lib/admin.js'
import { startOf, startInvalid, formatStart, toLocalInput, closingBeforeStart, effectiveEnd } from '../../lib/auction.js'
import { useNow } from '../../stores/clock.js'
import { subscribeKillSwitch } from '../../lib/items.js'
import ConfirmButton from './ConfirmButton.vue'

const props = defineProps({
  settings: { type: Object, required: true },
  items: { type: Array, default: () => [] },
})

const message = ref(props.settings.message ?? '')
const busy = ref(false)
const error = ref('')
watch(() => props.settings.message, (m) => (message.value = m ?? ''))

// Optional start time: with bidding switched on, bids are accepted from then
// (the rules check the server's clock) and bidders' pages open by themselves.
const now = useNow()
const start = computed(() => startOf(props.settings)) // NaN: not a timestamp (typed in the console)
const badStart = computed(() => startInvalid(props.settings))
const startAhead = computed(() => start.value != null && now.value < start.value)
const startLabel = computed(() => (start.value == null || badStart.value ? '' : formatStart(start.value, now.value)))
const startInput = ref('')
watch(start, (ms) => (startInput.value = ms == null || Number.isNaN(ms) ? '' : toLocalInput(new Date(ms))), { immediate: true })
// Items must close after the start, or they never open: refuse a start after any
// closing time, and point out items that already close before the current start
// (moved by the per-item controls, or an import without a start time).
const endOf = (it) => effectiveEnd(it, props.settings)
const newStartConflict = computed(() =>
  closingBeforeStart(props.items, startInput.value ? new Date(startInput.value).getTime() : null, endOf))
const Lots = (items) => lotsText(items).replace(/^l/, 'L') // at the start of a sentence
const currentConflict = computed(() => closingBeforeStart(props.items, start.value, endOf))
const saveStart = () => save(() => setStartTime(db, startInput.value ? new Date(startInput.value) : null))
const clearStart = () => save(() => setStartTime(db, null))

// Emergency stop (settings/killswitch): the rules then refuse every non-admin.
const killed = ref(false)
let unsubscribe = null
onMounted(() => {
  unsubscribe = subscribeKillSwitch(db, (on) => (killed.value = on), (e) => {
    console.error(e)
    error.value = 'Could not read the emergency stop state.'
  })
})
onUnmounted(() => unsubscribe?.())

async function toggleKillSwitch() {
  busy.value = true
  error.value = ''
  try {
    await setKillSwitch(db, !killed.value)
  } catch (e) {
    console.error(e)
    error.value = 'Could not change the emergency stop.'
  } finally {
    busy.value = false
  }
}

// A settings patch, or a function that writes one.
async function save(patch) {
  busy.value = true
  error.value = ''
  try {
    await (typeof patch === 'function' ? patch() : updateSettings(db, patch))
  } catch (e) {
    console.error(e)
    error.value = 'Could not save settings.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
    <h2 class="font-semibold">Bidding</h2>
    <div class="mt-3 flex flex-wrap items-center gap-3">
      <span
        :class="!settings.biddingOpen ? 'bg-amber-100 text-amber-900' : badStart ? 'bg-rose-100 text-rose-800' : startAhead ? 'bg-sky-100 text-sky-800' : 'bg-emerald-100 text-emerald-800'"
        class="rounded-full px-3 py-1 text-sm font-semibold"
      >
        {{ !settings.biddingOpen ? 'Paused' : badStart ? 'Blocked: invalid start time' : startAhead ? `Opens at ${startLabel}` : 'Open' }}
      </span>
      <ConfirmButton
        :disabled="busy"
        :danger="settings.biddingOpen"
        :confirm-label="settings.biddingOpen ? 'Pause for everyone?' : startAhead ? `Open at ${startLabel}?` : 'Open bidding now?'"
        @confirm="save({ biddingOpen: !settings.biddingOpen })"
      >
        {{ settings.biddingOpen ? 'Pause bidding' : 'Open bidding' }}
      </ConfirmButton>
    </div>

    <form class="mt-4 flex flex-col gap-2 sm:flex-row" @submit.prevent="save({ message: message.trim() })">
      <label class="sr-only" for="banner-message">Message shown to bidders</label>
      <input
        id="banner-message"
        v-model="message"
        maxlength="200"
        placeholder="Message shown to bidders while bidding is paused or before it starts (optional)"
        class="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
      />
      <button
        type="submit"
        :disabled="busy || message.trim() === (settings.message ?? '')"
        class="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
      >
        Save message
      </button>
    </form>

    <form class="mt-4 flex flex-wrap items-center gap-2" @submit.prevent="saveStart">
      <label for="start-time" class="text-sm font-medium">Bidding starts</label>
      <input id="start-time" v-model="startInput" type="datetime-local" class="rounded-md border border-slate-300 px-2 py-1 text-sm" />
      <button
        type="submit"
        :disabled="busy || !startInput || newStartConflict.length > 0 || (start != null && startInput === toLocalInput(new Date(start)))"
        class="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
      >
        Save start
      </button>
      <button
        v-if="start != null"
        type="button"
        :disabled="busy"
        class="rounded-md bg-white px-3 py-1.5 text-sm ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-40"
        @click="clearStart"
      >
        No start time
      </button>
    </form>
    <p v-if="badStart" class="mt-1 text-sm text-rose-700" role="alert">
      The start time stored for the auction isn't a date (edited by hand?), so every bid is refused. Set a new start or choose "No start time".
    </p>
    <p v-else-if="newStartConflict.length" class="mt-1 text-sm text-amber-800">
      {{ newStartConflict.length === items.length ? 'Every item closes' : `${Lots(newStartConflict)} close${newStartConflict.length === 1 ? 's' : ''}` }}
      before this start, so {{ newStartConflict.length === 1 ? 'it' : 'they' }} would never open. Choose an earlier start, or set the closing times first.
    </p>
    <p v-else-if="currentConflict.length" class="mt-1 text-sm text-amber-800" role="alert">
      {{ Lots(currentConflict) }} close{{ currentConflict.length === 1 ? 's' : '' }} before bidding starts and will never open.
      Move {{ currentConflict.length === 1 ? 'its closing time' : 'their closing times' }} or the start.
    </p>
    <p class="mt-1 text-xs text-slate-500">
      Optional. Switch bidding on beforehand: bids are accepted from this time (by the server's clock) and bidders' pages
      open by themselves. Until then they can browse the items and prices.
    </p>

    <p class="mt-3 text-xs text-slate-500">
      Min increment {{ settings.minIncrement }}<template v-if="settings.maxIncrement">, max {{ settings.maxIncrement }}</template>,
      anti-snipe {{ settings.antiSnipeSeconds }}s. Change these by importing the auction file.
    </p>
    <div class="mt-4 border-t border-slate-100 pt-3">
      <div class="flex flex-wrap items-center gap-3">
        <h3 class="text-sm font-semibold">Emergency stop</h3>
        <span
          :class="killed ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-600'"
          class="rounded-full px-3 py-1 text-xs font-semibold"
        >
          {{ killed ? 'On: only admins have access' : 'Off' }}
        </span>
        <ConfirmButton
          :disabled="busy"
          :danger="!killed"
          :confirm-label="killed ? 'Let bidders back in?' : 'Block every bidder now?'"
          @confirm="toggleKillSwitch"
        >
          {{ killed ? 'Resume access' : 'Block all bidder access' }}
        </ConfirmButton>
      </div>
      <p class="mt-1 text-xs text-slate-500">
        For abuse (e.g. a script running up the read bill): nobody but admins can read or bid until you resume.
        Bidders see "temporarily unavailable"; their pages reconnect by themselves within a minute of resuming.
        Pausing bidding is enough for everything else.
      </p>
    </div>
    <p v-if="error" class="mt-2 text-sm text-rose-700">{{ error }}</p>
  </section>
</template>
