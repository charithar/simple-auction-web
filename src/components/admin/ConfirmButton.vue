<script setup>
import { ref, onUnmounted } from 'vue'

// Two-step button for destructive actions: first click arms it, second confirms.
const props = defineProps({
  confirmLabel: { type: String, default: 'Click again to confirm' },
  disabled: { type: Boolean, default: false },
  danger: { type: Boolean, default: true },
})
const emit = defineEmits(['confirm'])

const armed = ref(false)
let timer = null

function click() {
  if (props.disabled) return
  if (armed.value) {
    clearTimeout(timer)
    armed.value = false
    emit('confirm')
  } else {
    armed.value = true
    timer = setTimeout(() => (armed.value = false), 4000)
  }
}
onUnmounted(() => clearTimeout(timer))
</script>

<template>
  <button
    type="button"
    :disabled="disabled"
    :class="armed
      ? (danger ? 'bg-rose-600 text-white hover:bg-rose-700' : 'bg-sky-600 text-white hover:bg-sky-700')
      : 'bg-white ring-1 ring-slate-300 hover:bg-slate-50'"
    class="rounded-md px-2.5 py-1 text-sm font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-40"
    @click="click"
  >
    <template v-if="armed">{{ confirmLabel }}</template>
    <slot v-else />
  </button>
</template>
