<script setup>
import { ref, computed } from 'vue'
import { db } from '../../firebase.js'
import { resetAllBids } from '../../lib/admin.js'
import ConfirmButton from './ConfirmButton.vue'

// Puts the whole auction back to before the first bid, keeping the items.
const props = defineProps({
  items: { type: Array, required: true },
  settings: { type: Object, required: true },
})

const bids = computed(() => props.items.reduce((n, it) => n + it.bidCount, 0))
const busy = ref(false)
const result = ref('')
const error = ref('')

async function reset() {
  busy.value = true
  result.value = ''
  error.value = ''
  try {
    const r = await resetAllBids(db, props.items, props.settings)
    result.value = `Reset done: ${r.bids} bid${r.bids === 1 ? '' : 's'} deleted, ${r.items} items back at their starting prices.`
  } catch (e) {
    console.error(e)
    error.value = 'Reset failed or stopped partway. Run it again to finish; items already reset are unaffected.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
    <h2 class="font-semibold">Reset all bids</h2>
    <p class="mt-1 text-sm text-slate-600">
      Deletes every bid and puts every item back to its starting price, with no leader: the auction as it was before
      the first bid. Items, closing times, settings and bidder accounts are kept.
    </p>
    <div class="mt-3 flex flex-wrap items-center gap-3">
      <ConfirmButton
        :disabled="busy || settings.biddingOpen || !items.length"
        danger
        :confirm-label="`Delete all ${bids} bids?`"
        @confirm="reset"
      >
        {{ busy ? 'Resetting…' : 'Reset all bids' }}
      </ConfirmButton>
      <span class="text-sm text-slate-500">{{ bids }} bid{{ bids === 1 ? '' : 's' }} on {{ items.length }} items</span>
    </div>
    <p class="mt-2 text-xs text-slate-500">
      Only while bidding is paused. Export the All bids CSV first if you need a record. To restore the original
      closing times too, re-import the auction file afterwards.
    </p>
    <p v-if="result" class="mt-2 text-sm text-emerald-700" role="status">{{ result }}</p>
    <p v-if="error" class="mt-2 text-sm text-rose-700" role="alert">{{ error }}</p>
  </section>
</template>
