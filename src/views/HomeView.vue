<script setup>
import { useAuthStore } from '../stores/auth.js'

const auth = useAuthStore()
</script>

<template>
  <div v-if="!auth.ready" class="py-16 text-center text-slate-500">Loading…</div>

  <!-- Items are readable only when signed in (protects the free read quota). -->
  <section v-else-if="!auth.signedIn" class="mx-auto max-w-md py-16 text-center">
    <h1 class="text-2xl font-semibold">Welcome to the auction</h1>
    <p class="mt-2 text-slate-600">Sign in with your Google account to see the items and place bids.</p>
    <button
      type="button"
      class="mt-6 rounded-md bg-slate-800 px-4 py-2 font-medium text-white hover:bg-slate-700"
      @click="auth.signIn()"
    >
      Sign in with Google
    </button>
  </section>

  <p v-else class="text-slate-500">Hi {{ auth.user.name }}. The item grid arrives in milestone 4.</p>
</template>
