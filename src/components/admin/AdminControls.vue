<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { db } from '../../firebase.js'
import {
  updateSettings, setKillSwitch, setStartTime, lotsText,
  ESCALATION_DEFAULTS, escalationProblem, escalationCapped, setEscalation,
} from '../../lib/admin.js'
import { startOf, startInvalid, formatStart, toLocalInput, closingBeforeStart, effectiveEnd, escalation } from '../../lib/auction.js'
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
// A message typed but not saved yet. Pausing saves it too: "pause with a message"
// is what the admin means, and bidders would otherwise see the old one.
const messageUnsaved = computed(() => message.value.trim() !== (props.settings.message ?? ''))
const toggleBidding = () => save(props.settings.biddingOpen
  ? { biddingOpen: false, ...(messageUnsaved.value ? { message: message.value.trim() } : {}) }
  : { biddingOpen: true })

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

// Raised minimum increment once a price is well above its start (settings.escalation;
// the rules enforce it). The form is reset only when the stored values change.
const esc = computed(() => ({ ...ESCALATION_DEFAULTS, ...props.settings.escalation }))
// What the rules apply: a malformed stored setting (edited by hand) raises nothing.
const escActive = computed(() => escalation(props.settings))
const escMalformed = computed(() => props.settings.escalation?.enabled === true && !escActive.value)
const escForm = ref({ enabled: false, percent: '', factor: '' })
watch(() => `${esc.value.enabled}|${esc.value.percent}|${esc.value.factor}`, () => {
  escForm.value = { enabled: esc.value.enabled === true, percent: String(esc.value.percent), factor: String(esc.value.factor) }
}, { immediate: true })
const escValues = computed(() => ({
  enabled: escForm.value.enabled,
  percent: /^\d+$/.test(escForm.value.percent.trim()) ? Number(escForm.value.percent.trim()) : NaN,
  factor: /^\d+$/.test(escForm.value.factor.trim()) ? Number(escForm.value.factor.trim()) : NaN,
}))
const escProblem = computed(() => escalationProblem(escValues.value))
const escChanged = computed(() => ['enabled', 'percent', 'factor'].some((k) => escValues.value[k] !== esc.value[k]))
const escCapped = computed(() =>
  escProblem.value ? [] : escalationCapped(props.items, props.settings, escValues.value.factor))
const saveEscalation = () => save(() => setEscalation(db, escValues.value))

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
        :confirm-label="settings.biddingOpen ? (messageUnsaved ? 'Pause with this message?' : 'Pause for everyone?') : startAhead ? `Open at ${startLabel}?` : 'Open bidding now?'"
        @confirm="toggleBidding"
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
        :disabled="busy || !messageUnsaved"
        class="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
      >
        Save message
      </button>
    </form>
    <p v-if="messageUnsaved" class="mt-1 text-xs text-amber-800">Not saved yet{{ settings.biddingOpen ? ' (pausing saves it too)' : '' }}.</p>

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

    <form class="mt-4 border-t border-slate-100 pt-3" data-escalation @submit.prevent="saveEscalation">
      <div class="flex flex-wrap items-center gap-3">
        <h3 class="text-sm font-semibold">Raised minimum increment</h3>
        <span
          :class="escActive ? 'bg-emerald-100 text-emerald-800' : escMalformed ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-600'"
          class="rounded-full px-3 py-1 text-xs font-semibold"
        >
          {{ escActive ? `On: ${escActive.factor}× once over ${100 + escActive.percent}% of the starting price` : escMalformed ? 'Off: invalid setting' : 'Off' }}
        </span>
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <label class="flex items-center gap-1.5">
          <input id="escalation-enabled" v-model="escForm.enabled" type="checkbox" class="h-4 w-4" />
          On
        </label>
        <label for="escalation-percent">when the price is over</label>
        <input
          id="escalation-percent"
          v-model="escForm.percent"
          inputmode="numeric"
          class="w-16 rounded-md border border-slate-300 px-2 py-1 text-right"
        />
        <span>% above the starting price,</span>
        <label for="escalation-factor">multiply the minimum increment by</label>
        <input
          id="escalation-factor"
          v-model="escForm.factor"
          inputmode="numeric"
          class="w-14 rounded-md border border-slate-300 px-2 py-1 text-right"
        />
        <button
          type="submit"
          :disabled="busy || !!escProblem || !escChanged"
          class="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          Save
        </button>
      </div>
      <p v-if="escProblem" class="mt-1 text-sm text-rose-700" role="alert">{{ escProblem }}</p>
      <p v-else-if="escMalformed && !escChanged" class="mt-1 text-sm text-rose-700" role="alert">
        The stored setting isn't valid (edited by hand?), so nothing is raised. Correct the values and save.
      </p>
      <p v-else-if="escChanged" class="mt-1 text-xs text-amber-800">Not saved yet.</p>
      <p v-if="!escProblem && escCapped.length" class="mt-1 text-xs text-amber-800">
        {{ escCapped.length === items.length ? 'For every item' : `For ${lotsText(escCapped)}` }}, this would pass the
        maximum increment, so the raised minimum is held at the maximum.
      </p>
      <p class="mt-1 text-xs text-slate-500">
        Applies to every item, judged on its current price, and takes effect at once (bidders' pages update by
        themselves). Example: starting price 4,000, over 25% means above 5,000; from then on, a minimum increment
        of 50 becomes 100.
      </p>
    </form>

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
