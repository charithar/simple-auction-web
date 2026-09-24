<script setup>
import { computed } from 'vue'
import { formatMoney } from '../lib/auction.js'
import ItemImage from './ItemImage.vue'
import StandingBadge from './StandingBadge.vue'
import TimeLeft from './TimeLeft.vue'

const props = defineProps({
  item: { type: Object, required: true },
  view: { type: Object, required: true },
})
defineEmits(['open'])

const keySpecs = computed(() =>
  props.item.specs?.filter((s) => ['CPU', 'RAM', 'Storage'].includes(s.name)).map((s) => s.value).join(' · '),
)
const ring = computed(() => ({
  winning: 'ring-2 ring-emerald-500',
  outbid: 'ring-2 ring-rose-500',
  won: 'ring-2 ring-emerald-600',
})[props.view.standing] ?? 'ring-1 ring-slate-200')
</script>

<template>
  <button
    type="button"
    :class="[ring, { 'opacity-75': view.ended }]"
    class="group flex flex-col overflow-hidden rounded-xl bg-white text-left shadow-sm transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
    @click="$emit('open', item.id)"
  >
    <div class="relative">
      <ItemImage :src="item.images?.[0]" :alt="item.title" />
      <div class="absolute top-2 left-2"><StandingBadge :standing="view.standing" /></div>
      <span
        v-if="item.condition && item.condition !== 'Used'"
        class="absolute top-2 right-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
      >
        {{ item.condition }}
      </span>
    </div>

    <div class="flex flex-1 flex-col gap-1 border-t border-slate-100 p-3">
      <div class="text-xs text-slate-400">Lot {{ item.order }}</div>
      <h2 class="leading-snug font-semibold group-hover:text-sky-700">{{ item.title }}</h2>
      <p v-if="keySpecs" class="text-sm text-slate-600">{{ keySpecs }}</p>
      <p v-if="item.subtitle" class="text-xs text-slate-400">{{ item.subtitle }}</p>

      <div class="mt-auto flex flex-wrap items-end justify-between gap-x-2 gap-y-1 pt-2">
        <div>
          <div class="text-lg font-bold whitespace-nowrap tabular-nums">{{ formatMoney(item.currency, item.currentAmount) }}</div>
          <div class="text-xs text-slate-500">
            {{ item.bidCount === 0 ? 'Starting price' : `${item.bidCount} bid${item.bidCount === 1 ? '' : 's'}` }}
          </div>
        </div>
        <TimeLeft :view="view" class="text-sm whitespace-nowrap" />
      </div>
    </div>
  </button>
</template>
