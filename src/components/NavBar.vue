<script setup>
import { RouterLink, useRoute } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'
import { useAuctionStore } from '../stores/auction.js'

const auth = useAuthStore()
const auction = useAuctionStore()
const route = useRoute()
</script>

<template>
  <header class="bg-slate-800 text-white">
    <nav class="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
      <RouterLink to="/" class="truncate text-lg font-semibold">{{ auction.settings?.title || 'Auction' }}</RouterLink>
      <!-- Tells people prices update by themselves, so they don't keep refreshing. -->
      <span
        v-if="auth.signedIn"
        class="mr-auto flex shrink-0 items-center gap-1.5 text-xs text-slate-300"
        :title="auction.connection === 'live' ? 'Prices update automatically. No need to refresh.' : ''"
      >
        <span
          class="size-2 rounded-full"
          :class="auction.connection === 'live' ? 'animate-pulse bg-emerald-400' : 'bg-amber-400'"
        ></span>
        <span class="hidden sm:inline">{{ { live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…' }[auction.connection] }}</span>
      </span>
      <span v-else class="mr-auto"></span>

      <template v-if="!auth.ready || auth.busy">
        <span class="text-sm text-slate-400">Loading…</span>
      </template>

      <!-- Signed in with Google but refused for now (emergency stop): retrying, no "Sign in". -->
      <template v-else-if="auth.retrying">
        <span class="text-sm text-slate-400">Reconnecting…</span>
      </template>

      <template v-else-if="auth.signedIn">
        <RouterLink
          v-if="auth.isAdmin"
          :to="route.name === 'admin' ? '/' : '/admin'"
          class="rounded-md bg-slate-700 px-3 py-1.5 text-sm hover:bg-slate-600"
        >
          {{ route.name === 'admin' ? 'Items' : 'Admin' }}
        </RouterLink>
        <img
          v-if="auth.user.photoURL"
          :src="auth.user.photoURL"
          alt=""
          referrerpolicy="no-referrer"
          class="hidden size-8 rounded-full sm:block"
        />
        <span class="hidden max-w-40 truncate text-sm sm:inline">{{ auth.user.name }}</span>
        <button
          type="button"
          class="rounded-md bg-slate-700 px-3 py-1.5 text-sm whitespace-nowrap hover:bg-slate-600"
          @click="auth.signOut()"
        >
          Sign out
        </button>
      </template>

      <button
        v-else
        type="button"
        class="rounded-md bg-white px-3 py-1.5 text-sm font-medium whitespace-nowrap text-slate-900 hover:bg-slate-100"
        @click="auth.signIn()"
      >
        Sign in with Google
      </button>
    </nav>
  </header>
</template>
