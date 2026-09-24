<script setup>
import { watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth.js'
import { useAuctionStore } from './stores/auction.js'
import NavBar from './components/NavBar.vue'

const auth = useAuthStore()
auth.init()
const auction = useAuctionStore()
auction.init()

watch(
  () => auction.settings?.title,
  (title) => (document.title = title || 'Auction'),
  { immediate: true },
)

// Leave admin pages as soon as admin rights go away (e.g. sign-out).
const route = useRoute()
const router = useRouter()
watch(
  () => auth.isAdmin,
  (admin) => {
    if (!admin && route.meta.requiresAdmin) router.replace({ name: 'home' })
  },
)
</script>

<template>
  <NavBar />
  <div v-if="auth.error" class="bg-red-50 text-red-800" role="alert">
    <div class="mx-auto max-w-6xl px-4 py-2 text-sm">{{ auth.error }}</div>
  </div>
  <main class="mx-auto max-w-6xl px-4 py-6">
    <RouterView />
  </main>
</template>
