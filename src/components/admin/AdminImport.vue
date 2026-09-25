<script setup>
import { ref, computed } from 'vue'
import { db } from '../../firebase.js'
import { parseAuctionFile } from '../../lib/importItems.js'
import { planImport, applyImport } from '../../lib/admin.js'
import ConfirmButton from './ConfirmButton.vue'

const props = defineProps({
  items: { type: Array, required: true },
  catalog: { type: Array, default: null },
  settings: { type: Object, default: null },
})

const fileName = ref('')
const errors = ref([])
const parsed = ref(null)
const removeMissing = ref(false)
const busy = ref(false)
const result = ref('')
const input = ref(null)

// Recomputed against the live items, so the preview stays correct if bids arrive meanwhile.
const plan = computed(() => (parsed.value ? planImport(parsed.value, props.items, props.catalog) : null))
const FIELD_LABELS = { endTime: 'closing time', startingPrice: 'starting price', minIncrement: 'min increment', maxIncrement: 'max increment' }
const fieldCounts = computed(() => {
  const counts = new Map()
  for (const u of plan.value?.updates ?? []) for (const f of u.changes) counts.set(f, (counts.get(f) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${FIELD_LABELS[f] ?? f} ×${n}`)
})
const warnings = computed(() => plan.value?.updates.filter((u) => u.warnings.length) ?? [])
const settingsChanged = computed(() =>
  plan.value && (!props.settings ||
    ['title', 'minIncrement', 'maxIncrement', 'antiSnipeSeconds'].some((k) => (plan.value.settings[k] ?? null) !== (props.settings[k] ?? null))),
)
const nothingToDo = computed(() =>
  plan.value && !settingsChanged.value && !plan.value.catalogStale && !plan.value.creates.length && !plan.value.updates.length &&
  !(removeMissing.value && plan.value.missing.some((m) => !m.hasBids)),
)

async function onFile(e) {
  const file = e.target.files?.[0]
  result.value = ''
  parsed.value = null
  errors.value = []
  if (!file) return
  fileName.value = file.name
  const out = parseAuctionFile(await file.text())
  if (out.errors.length) errors.value = out.errors
  else parsed.value = out
}

async function apply() {
  busy.value = true
  result.value = ''
  try {
    const r = await applyImport(db, plan.value, { removeMissing: removeMissing.value })
    result.value = `Imported: ${r.created} added, ${r.updated} updated${r.removed ? `, ${r.removed} removed` : ''}. Settings updated.` +
      (r.skipped.length
        ? ` ${r.skipped.join(', ')} received bids after the preview, so their price, closing time and increments were left unchanged.`
        : '')
    parsed.value = null
    fileName.value = ''
    input.value.value = ''
  } catch (e) {
    console.error(e)
    errors.value = [`Import failed: ${e.message}`]
  } finally {
    busy.value = false
  }
}

const fmtFields = (fields) => fields.map((f) => FIELD_LABELS[f] ?? f).join(', ')
</script>

<template>
  <section class="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
    <h2 class="font-semibold">Import auction file</h2>
    <p class="mt-1 text-sm text-slate-600">
      Choose an <code>auction.yml</code> (or .json). You'll see what changes before anything is written.
      Bids and the open/paused state are kept.
    </p>

    <input
      ref="input"
      type="file"
      accept=".yml,.yaml,.json"
      class="mt-3 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-800 file:px-3 file:py-1.5 file:text-white"
      @change="onFile"
    />

    <div v-if="errors.length" class="mt-3 rounded-md bg-rose-50 p-3 text-sm text-rose-800" role="alert">
      <p class="font-medium">{{ fileName }} has {{ errors.length }} problem{{ errors.length === 1 ? '' : 's' }}:</p>
      <ul class="mt-1 list-disc pl-5">
        <li v-for="e in errors.slice(0, 20)" :key="e">{{ e }}</li>
      </ul>
      <p v-if="errors.length > 20" class="mt-1">…and {{ errors.length - 20 }} more.</p>
    </div>

    <div v-if="plan" class="mt-4 flex flex-col gap-3 text-sm">
      <div class="flex flex-wrap gap-2">
        <span class="rounded-full bg-emerald-100 px-2.5 py-0.5 text-emerald-800">{{ plan.creates.length }} new</span>
        <span class="rounded-full bg-sky-100 px-2.5 py-0.5 text-sky-800">{{ plan.updates.length }} changed</span>
        <span class="rounded-full bg-slate-100 px-2.5 py-0.5 text-slate-700">{{ plan.unchanged.length }} unchanged</span>
        <span v-if="plan.missing.length" class="rounded-full bg-amber-100 px-2.5 py-0.5 text-amber-900">{{ plan.missing.length }} not in file</span>
      </div>

      <p v-if="plan.catalogStale && !plan.creates.length && !plan.updates.length" class="text-slate-700">
        The bidder catalog is out of date and will be rebuilt.
      </p>
      <p v-if="fieldCounts.length" class="text-slate-700">
        Changes: {{ fieldCounts.join(', ') }}
      </p>

      <p class="text-slate-600">
        <span v-if="settingsChanged" class="font-medium text-sky-800">Settings will change: </span>
        <template v-else>Settings (unchanged): </template> “{{ plan.settings.title }}”, min increment {{ plan.settings.minIncrement }}<template v-if="plan.settings.maxIncrement">, max {{ plan.settings.maxIncrement }}</template>, anti-snipe {{ plan.settings.antiSnipeSeconds }}s.
      </p>

      <div v-if="warnings.length" class="rounded-md bg-amber-50 p-3 text-amber-900">
        <p class="font-medium">These items already have bids and their bidding terms will change:</p>
        <ul class="mt-1 list-disc pl-5">
          <li v-for="u in warnings" :key="u.item.id">Lot {{ u.item.order }} {{ u.item.title }}: {{ fmtFields(u.warnings) }}</li>
        </ul>
      </div>

      <details v-if="plan.updates.length">
        <summary class="cursor-pointer text-slate-700">Changed items</summary>
        <ul class="mt-1 list-disc pl-5 text-slate-600">
          <li v-for="u in plan.updates" :key="u.item.id">Lot {{ u.item.order }} {{ u.item.title }}: {{ fmtFields(u.changes) }}</li>
        </ul>
      </details>
      <details v-if="plan.creates.length">
        <summary class="cursor-pointer text-slate-700">New items</summary>
        <ul class="mt-1 list-disc pl-5 text-slate-600">
          <li v-for="c in plan.creates" :key="c.id">Lot {{ c.order }} {{ c.title }} (closes {{ c.endTime.toLocaleString() }})</li>
        </ul>
      </details>

      <label v-if="plan.missing.length" class="flex items-start gap-2">
        <input v-model="removeMissing" type="checkbox" class="mt-0.5" />
        <span>
          Remove the {{ plan.missing.filter((m) => !m.hasBids).length }} item(s) that aren't in the file
          <template v-if="plan.missing.some((m) => m.hasBids)">
            ({{ plan.missing.filter((m) => m.hasBids).length }} with bids will be kept)
          </template>
        </span>
      </label>

      <div>
        <ConfirmButton :disabled="busy || nothingToDo" :danger="warnings.length > 0" confirm-label="Apply import now?" @confirm="apply">
          {{ busy ? 'Importing…' : nothingToDo ? 'Nothing to import' : 'Apply import' }}
        </ConfirmButton>
      </div>
    </div>

    <p v-if="result" class="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">{{ result }}</p>
  </section>
</template>
