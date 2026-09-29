<script setup>
import { ref, computed, watch } from 'vue'
import { db } from '../../firebase.js'
import { planSchedule, setClosingSchedule, currentSchedule } from '../../lib/admin.js'
import { parseDuration, formatDuration } from '../../lib/importItems.js'
import { toLocalInput } from '../../lib/auction.js'
import { useNow } from '../../stores/clock.js'
import ConfirmButton from './ConfirmButton.vue'

// Setting up the auction: all closing times from one schedule (like auction.endTime
// and stagger in the file), without re-importing. Only before any bids.
const props = defineProps({
  items: { type: Array, required: true },
  settings: { type: Object, required: true },
})

const now = useNow()
const firstInput = ref('')
const gapInput = ref('')
const busy = ref(false)
const result = ref('')
const error = ref('')

// Pre-fill with the schedule the items follow now, and follow it (e.g. per-item
// changes, an import) until the admin starts typing. `uneven`: the current closing
// times aren't evenly spaced, so the suggested gap is only a default.
const touched = ref(false)
const uneven = ref(false)
const schedule = computed(() => currentSchedule(props.items))
function fill() {
  const { firstEnd, staggerMs } = schedule.value
  firstInput.value = firstEnd == null ? '' : toLocalInput(new Date(firstEnd))
  gapInput.value = formatDuration(staggerMs ?? 60_000)
  uneven.value = firstEnd != null && staggerMs == null
  touched.value = false
}
watch(() => `${schedule.value.firstEnd}:${schedule.value.staggerMs}`, () => touched.value || fill(), { immediate: true })
function onInput() {
  touched.value = true
  error.value = ''
  result.value = ''
}

const plan = computed(() => planSchedule(
  props.items,
  firstInput.value ? new Date(firstInput.value).getTime() : NaN,
  parseDuration(gapInput.value.trim() || '0'),
  props.settings,
  now.value,
))
const fmt = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
const first = computed(() => plan.value.ends?.[0])
const last = computed(() => plan.value.ends?.at(-1))

async function apply() {
  busy.value = true
  error.value = ''
  result.value = ''
  try {
    const n = await setClosingSchedule(db, plan.value.ends)
    result.value = `Closing times set for ${n} item(s).`
    fill()
  } catch (e) {
    console.error(e)
    error.value = e.message?.startsWith('An item got a bid') ? e.message : 'Could not set the closing times.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
    <h2 class="font-semibold">Closing times</h2>
    <p class="mt-1 text-sm text-slate-600">
      For setting up the auction: every item's closing time in lot order, without re-importing the file. Only before any bids.
    </p>
    <form class="mt-3 flex flex-wrap items-end gap-3" @submit.prevent>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">First item closes</span>
        <input id="schedule-first" v-model="firstInput" type="datetime-local" class="rounded-md border border-slate-300 px-2 py-1" @input="onInput" />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Each next one later by</span>
        <input id="schedule-gap" v-model="gapInput" placeholder="1m" class="w-24 rounded-md border border-slate-300 px-2 py-1" @input="onInput" />
      </label>
      <ConfirmButton
        :disabled="busy || !!plan.error"
        :danger="false"
        :confirm-label="`Set ${plan.ends?.length ?? 0} closing times?`"
        @confirm="apply"
      >
        Set closing times
      </ConfirmButton>
    </form>
    <p v-if="uneven && !touched && !plan.error" class="mt-2 text-sm text-slate-600">
      The current closing times aren't evenly spaced; applying replaces them all with this schedule.
    </p>
    <p v-if="plan.error" class="mt-2 text-sm text-amber-800">{{ plan.error }}</p>
    <p v-else class="mt-2 text-sm text-slate-600">
      Lot {{ first.order }} closes {{ fmt(first.end) }}<template v-if="plan.ends.length > 1">, lot {{ last.order }} (the last) {{ fmt(last.end) }}</template>.
    </p>
    <p v-if="result" class="mt-2 text-sm text-emerald-700" role="status">{{ result }}</p>
    <p v-if="error" class="mt-2 text-sm text-rose-700">{{ error }}</p>
  </section>
</template>
