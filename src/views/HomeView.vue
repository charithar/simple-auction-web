<script setup>
import { ref, computed, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'
import { useAuctionStore } from '../stores/auction.js'
import { useNow } from '../stores/clock.js'
import { viewFor } from '../lib/itemView.js'
import ItemCard from '../components/ItemCard.vue'
import BidDialog from '../components/BidDialog.vue'

const auth = useAuthStore()
const auction = useAuctionStore()
const now = useNow()
const route = useRoute()
const router = useRouter()

const filter = ref('all')
const sort = ref('lot')
const search = ref('')

// The open item lives in the URL (#/?item=item-007) so it survives reloads and can be shared.
const openItemId = computed(() => (typeof route.query.item === 'string' ? route.query.item : null))
const openItem = (id) => router.push({ query: { ...route.query, item: id } })
const closeItem = () => {
  if (openItemId.value) router.replace({ query: { ...route.query, item: undefined } })
}

const rows = computed(() => {
  if (!auction.settings) return []
  const ctx = { settings: auction.settings, uid: auth.user?.uid, myBidItemIds: auction.myBidItemIds, now: now.value }
  return auction.items.map((item) => ({ item, view: viewFor(item, ctx) }))
})

// Live prices only for cards on (or near) the screen. See stores/auction.js.
const releases = new Map() // element -> release()
const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const id = e.target.dataset.itemId
      if (e.isIntersecting && !releases.has(e.target)) releases.set(e.target, auction.watchItem(id, 'visible'))
      if (!e.isIntersecting && releases.has(e.target)) {
        releases.get(e.target)()
        releases.delete(e.target)
      }
    }
  },
  { rootMargin: '400px 0px' }, // start loading a little before a card scrolls in
)
const vWatchVisible = {
  mounted(el, { value }) {
    el.dataset.itemId = value
    observer.observe(el)
  },
  unmounted(el) {
    observer.unobserve(el)
    releases.get(el)?.()
    releases.delete(el)
  },
}
onUnmounted(() => {
  observer.disconnect()
  releases.forEach((release) => release())
  releases.clear()
})

const price = (item) => item.currentAmount ?? item.startingPrice

const counts = computed(() => {
  const c = { mine: 0, winning: 0, outbid: 0 }
  for (const { view } of rows.value) {
    if (view.standing) c.mine++
    if (view.standing === 'winning') c.winning++
    if (view.standing === 'outbid') c.outbid++
  }
  return c
})

const visible = computed(() => {
  const q = search.value.trim().toLowerCase()
  let list = rows.value.filter(({ item, view }) => {
    if (filter.value === 'mine' && !view.standing) return false
    if (filter.value === 'outbid' && view.standing !== 'outbid') return false
    if (filter.value === 'open' && view.ended) return false
    if (!q) return true
    const haystack = [item.title, item.subtitle, item.detail, item.category, `lot ${item.order}`, ...(item.specs ?? []).map((s) => s.value)]
      .join(' ')
      .toLowerCase()
    return haystack.includes(q)
  })
  if (sort.value === 'ending') list = [...list].sort((a, b) => (a.view.ended - b.view.ended) || a.view.end - b.view.end)
  if (sort.value === 'price-asc') list = [...list].sort((a, b) => price(a.item) - price(b.item))
  if (sort.value === 'price-desc') list = [...list].sort((a, b) => price(b.item) - price(a.item))
  return list
})

const filters = computed(() => [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'mine', label: `My bids${counts.value.mine ? ` (${counts.value.mine})` : ''}` },
  { key: 'outbid', label: `Outbid${counts.value.outbid ? ` (${counts.value.outbid})` : ''}` },
])
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

  <template v-else>
    <div v-if="auction.error" class="mb-4 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">
      {{ auction.error }}
    </div>

    <div
      v-if="auction.connection === 'cooldown'"
      class="mb-4 rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-900"
      role="status"
    >
      <strong>No need to refresh:</strong> prices and countdowns update by themselves.
      Showing the last known prices; live updates resume in
      {{ Math.max(1, Math.ceil((auction.cooldownUntil - now) / 1000)) }}s.
    </div>

    <div v-if="!auction.loaded" class="py-16 text-center text-slate-500">Loading items…</div>

    <div v-else-if="!auction.settings || !auction.catalog?.length" class="py-16 text-center text-slate-500">
      The auction hasn't been set up yet. Check back soon.
    </div>

    <template v-else>
      <div
        v-if="!auction.settings.biddingOpen"
        class="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900"
        role="status"
      >
        <strong>Bidding is currently closed.</strong>
        <span v-if="auction.settings.message"> {{ auction.settings.message }}</span>
      </div>

      <div
        v-if="counts.winning || counts.outbid"
        class="mb-4 flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-white px-4 py-3 text-sm shadow-sm ring-1 ring-slate-200"
      >
        <span v-if="counts.winning" class="font-medium text-emerald-700">You're winning {{ counts.winning }} item{{ counts.winning === 1 ? '' : 's' }}</span>
        <button v-if="counts.outbid" type="button" class="font-medium text-rose-700 underline-offset-2 hover:underline" @click="filter = 'outbid'">
          Outbid on {{ counts.outbid }}: bid again?
        </button>
      </div>

      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div class="flex gap-1 overflow-x-auto rounded-lg bg-slate-200/60 p-1" role="tablist">
          <button
            v-for="f in filters"
            :key="f.key"
            type="button"
            role="tab"
            :aria-selected="filter === f.key"
            :class="filter === f.key ? 'bg-white shadow-sm' : 'text-slate-600 hover:text-slate-900'"
            class="rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap"
            @click="filter = f.key"
          >
            {{ f.label }}
          </button>
        </div>
        <input
          v-model="search"
          type="search"
          placeholder="Search items, specs, serials…"
          aria-label="Search items"
          class="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-sky-500 focus:ring-2 focus:ring-sky-200 focus:outline-none"
        />
        <select
          v-model="sort"
          aria-label="Sort items"
          class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="lot">Lot number</option>
          <option value="ending">Ending soonest</option>
          <option value="price-asc">Price: low to high</option>
          <option value="price-desc">Price: high to low</option>
        </select>
      </div>

      <p v-if="visible.length === 0" class="py-12 text-center text-slate-500">No items match.</p>
      <div v-else class="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
        <ItemCard
          v-for="r in visible"
          :key="r.item.id"
          v-watch-visible="r.item.id"
          :item="r.item"
          :view="r.view"
          @open="openItem"
        />
      </div>

      <BidDialog :item-id="openItemId" :now="now" @close="closeItem" />
    </template>
  </template>
</template>
