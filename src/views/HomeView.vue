<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'
import { useAuctionStore } from '../stores/auction.js'
import { useNow } from '../stores/clock.js'
import { viewFor, matchesFilter } from '../lib/itemView.js'
import { allowedDomainsText } from '../lib/access.js'
import ItemCard from '../components/ItemCard.vue'
import BidDialog from '../components/BidDialog.vue'
import OutbidToasts from '../components/OutbidToasts.vue'
import { myBidsSummary, formatTotal } from '../lib/myBids.js'
import { useOutbidAlerts } from '../composables/useOutbidAlerts.js'

const auth = useAuthStore()
const auction = useAuctionStore()
const now = useNow()
const route = useRoute()
const router = useRouter()

const filter = ref('all')
const sort = ref('lot')
const search = ref('')

// The open item lives in the URL (#/?item=item-007) so it survives reloads and can be shared.
// Only item-NNN ids (itemDocId): anything else in a crafted link would reach doc()
// as a path (e.g. "x/bids/1") when bidding.
const ITEM_ID = /^item-\d{3,}$/
const openItemId = computed(() => {
  const id = route.query.item
  return typeof id === 'string' && ITEM_ID.test(id) ? id : null
})
const openItem = (id) => router.push({ query: { ...route.query, item: id } })
const closeItem = () => {
  if (openItemId.value) router.replace({ query: { ...route.query, item: undefined } })
}

const rows = computed(() => {
  if (!auction.settings) return []
  const ctx = { settings: auction.settings, uid: auth.user?.uid, myBidItemIds: auction.myBidItemIds, now: now.value }
  return auction.items.map((item) => ({ item, view: viewFor(item, ctx) }))
})

const price = (item) => item.currentAmount ?? item.startingPrice

// The bidder's position: winning (and what that commits them to), outbid, won.
const mine = computed(() => myBidsSummary(rows.value))
const counts = computed(() => {
  const m = mine.value
  return { mine: m.winning.length + m.outbid.length + m.won.length + m.lost.length, outbid: m.outbid.length }
})
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

const { toasts, dismiss } = useOutbidAlerts(rows, openItem)

const visible = computed(() => {
  const q = search.value.trim().toLowerCase()
  let list = rows.value.filter(({ item, view }) => {
    if (!matchesFilter(filter.value, view)) return false
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

  <!-- Items are readable only when signed in (keeps outsiders from running up reads). -->
  <section v-else-if="!auth.signedIn" class="mx-auto max-w-md py-16 text-center">
    <h1 class="text-2xl font-semibold">Welcome to the auction</h1>
    <p class="mt-2 text-slate-600">Sign in with your {{ allowedDomainsText() }} Google account to see the items and place bids.</p>
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

    <div v-if="!auction.loaded" class="py-16 text-center text-slate-500">Loading items…</div>

    <div v-else-if="!auction.settings || !auction.items.length" class="py-16 text-center text-slate-500">
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
        v-if="mine.winning.length || mine.outbid.length || mine.won.length"
        class="mb-4 flex flex-wrap gap-x-5 gap-y-1 rounded-lg bg-white px-4 py-3 text-sm shadow-sm ring-1 ring-slate-200"
      >
        <span v-if="mine.won.length" class="font-semibold text-emerald-800">
          You won {{ plural(mine.won.length, 'item') }}: {{ formatTotal(mine.won) }} in total
        </span>
        <span v-if="mine.winning.length" class="font-medium text-emerald-700">
          Winning {{ plural(mine.winning.length, 'item') }} · {{ formatTotal(mine.winning) }} if they close now
        </span>
        <button v-if="mine.outbid.length" type="button" class="font-medium text-rose-700 underline-offset-2 hover:underline" @click="filter = 'outbid'">
          Outbid on {{ mine.outbid.length }}: bid again?
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
          :item="r.item"
          :view="r.view"
          @open="openItem"
        />
      </div>

      <BidDialog :item-id="openItemId" :now="now" @close="closeItem" />
      <OutbidToasts :toasts="toasts" @open="openItem" @dismiss="dismiss" />
    </template>
  </template>
</template>
