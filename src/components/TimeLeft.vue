<script setup>
import { formatRemaining } from '../lib/auction.js'

defineProps({ view: { type: Object, required: true } })
</script>

<template>
  <span
    :class="{
      'text-slate-500': view.status === 'ended',
      'font-semibold text-rose-600': view.status === 'closing',
      'text-slate-700': view.status === 'open',
    }"
    class="tabular-nums"
  >
    <template v-if="view.ended">Ended</template>
    <template v-else>
      {{ formatRemaining(view.remaining) }} left<span v-if="view.extended" class="font-normal"> · extended</span>
    </template>
  </span>
</template>
