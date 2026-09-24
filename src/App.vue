<script setup>
import { RouterView } from 'vue-router'
</script>

<template>
  <header class="bg-slate-800 text-white">
    <div class="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
      <span class="text-lg font-semibold">Auction</span>
    </div>
  </header>
  <main class="mx-auto max-w-6xl px-4 py-6">
    <RouterView />
  </main>
</template>
