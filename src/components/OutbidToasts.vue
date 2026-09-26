<script setup>
defineProps({ toasts: { type: Array, required: true } })
defineEmits(['open', 'dismiss'])
</script>

<template>
  <div class="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 p-4 sm:items-end" aria-live="polite">
    <div
      v-for="t in toasts"
      :key="t.id"
      role="status"
      class="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg bg-rose-700 px-4 py-3 text-sm text-white shadow-lg"
    >
      <p class="flex-1">{{ t.text }}</p>
      <button type="button" class="shrink-0 font-semibold underline underline-offset-2" @click="$emit('open', t.itemId); $emit('dismiss', t.id)">
        Bid again
      </button>
      <button type="button" class="shrink-0 text-rose-200 hover:text-white" aria-label="Dismiss" @click="$emit('dismiss', t.id)">✕</button>
    </div>
  </div>
</template>
