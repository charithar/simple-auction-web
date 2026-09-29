<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { db } from '../../firebase.js'
import { updateSettings, setKillSwitch, setStartTime } from '../../lib/admin.js'
import { startOf, formatStart, toLocalInput } from '../../lib/auction.js'
import { useNow } from '../../stores/clock.js'
import { subscribeKillSwitch } from '../../lib/items.js'
import ConfirmButton from './ConfirmButton.vue'

const props = defineProps({ settings: { type: Object, required: true } })

const message = ref(props.settings.message ?? '')
const busy = ref(false)
const error = ref('')
watch(() => props.settings.message, (m) => (message.value = m ?? ''))

// Optional start time: with bidding switched on, bids are accepted from then
// (the rules check the server's clock) and bidders' pages open by themselves.
const now = useNow()
const start = computed(() => startOf(props.settings))
const startAhead = computed(() => start.value != null && now.value < start.value)
const startLabel = computed(() => (start.value == null ? '' : formatStart(start.value, now.value)))
const startInput = ref('')
watch(start, (ms) => (startInput.value = ms == null ? '' : toLocalInput(new Date(ms))), { immediate: true })
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
        :class="!settings.biddingOpen ? 'bg-amber-100 text-amber-900' : startAhead ? 'bg-sky-100 text-sky-800' : 'bg-emerald-100 text-emerald-800'"
        class="rounded-full px-3 py-1 text-sm font-semibold"
      >
        {{ !settings.biddingOpen ? 'Paused' : startAhead ? `Opens at ${startLabel}` : 'Open' }}
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
        :disabled="busy || !startInput || (start != null && startInput === toLocalInput(new Date(start)))"
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
