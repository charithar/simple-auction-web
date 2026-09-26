<script setup>
import { formatRemaining } from '../lib/auction.js'

defineProps({ view: { type: Object, required: true } })
</script>

<template>
  <span
    :class="{
      'text-slate-500': view.status === 'ended',
      'font-semibold text-rose-600': view.status === 'closing',
      'animate-pulse': view.final,
      'text-slate-700': view.status === 'open',
    }"
    class="tabular-nums"
  >
    <template v-if="view.ended">Ended</template>
    <template v-else>
      {{ formatRemaining(view.remaining) }} left<span
        v-if="view.extended"
        :class="view.final ? 'ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800' : 'font-normal'"
      >{{ view.final ? 'extended' : ' · extended' }}</span>
    </template>
  </span>
</template>
