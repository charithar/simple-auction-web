<script setup>
import { ref, watch } from 'vue'
import { db } from '../../firebase.js'
import { updateSettings } from '../../lib/admin.js'
import ConfirmButton from './ConfirmButton.vue'

const props = defineProps({ settings: { type: Object, required: true } })

const message = ref(props.settings.message ?? '')
const busy = ref(false)
const error = ref('')
watch(() => props.settings.message, (m) => (message.value = m ?? ''))

async function save(patch) {
  busy.value = true
  error.value = ''
  try {
    await updateSettings(db, patch)
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
        :class="settings.biddingOpen ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'"
        class="rounded-full px-3 py-1 text-sm font-semibold"
      >
        {{ settings.biddingOpen ? 'Open' : 'Paused' }}
      </span>
      <ConfirmButton
        :disabled="busy"
        :danger="settings.biddingOpen"
        :confirm-label="settings.biddingOpen ? 'Pause for everyone?' : 'Open bidding now?'"
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
        placeholder="Message shown to bidders while bidding is paused (optional)"
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

    <p class="mt-3 text-xs text-slate-500">
      Min increment {{ settings.minIncrement }}<template v-if="settings.maxIncrement">, max {{ settings.maxIncrement }}</template>,
      anti-snipe {{ settings.antiSnipeSeconds }}s. Change these by importing the auction file.
    </p>
    <p v-if="error" class="mt-2 text-sm text-rose-700">{{ error }}</p>
  </section>
</template>
