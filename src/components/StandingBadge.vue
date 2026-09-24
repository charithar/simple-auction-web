<script setup>
defineProps({ standing: { type: String, default: null } })

const styles = {
  winning: ['bg-emerald-600 text-white', "You're winning"],
  outbid: ['bg-rose-600 text-white', 'Outbid'],
  won: ['bg-emerald-700 text-white', 'You won'],
  lost: ['bg-slate-500 text-white', 'Not won'],
}
</script>

<template>
  <span
    v-if="standing"
    :class="styles[standing][0]"
    class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold shadow-sm"
  >
    {{ styles[standing][1] }}
  </span>
</template>
