<script setup>
import { computed, ref, watch } from 'vue'
import { imageUrlOk } from '../lib/images.js'

const props = defineProps({
  src: { type: String, default: '' },
  alt: { type: String, default: '' },
  eager: { type: Boolean, default: false },
})

const failed = ref(false)
// Same check as the import, for data written some other way: anything else shows the placeholder.
const safeSrc = computed(() => (props.src && imageUrlOk(props.src) ? props.src : ''))
watch(() => props.src, () => (failed.value = false))
</script>

<template>
  <div class="flex aspect-square items-center justify-center overflow-hidden bg-white">
    <!-- no-referrer: many hosts block hotlinked images based on the Referer header -->
    <img
      v-if="safeSrc && !failed"
      :src="safeSrc"
      :alt="alt"
      :loading="eager ? 'eager' : 'lazy'"
      referrerpolicy="no-referrer"
      class="size-full object-contain"
      @error="failed = true"
    />
    <svg v-else class="size-1/3 text-slate-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  </div>
</template>
