<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  src: { type: String, default: '' },
  alt: { type: String, default: '' },
  eager: { type: Boolean, default: false },
})

const failed = ref(false)
watch(() => props.src, () => (failed.value = false))
</script>

<template>
  <div class="flex aspect-square items-center justify-center overflow-hidden bg-white">
    <!-- no-referrer: many hosts block hotlinked images based on the Referer header -->
    <img
      v-if="src && !failed"
      :src="src"
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
