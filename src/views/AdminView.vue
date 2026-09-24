<script setup>
import { ref, computed } from 'vue'
import { db } from '../firebase.js'
import { useAuthStore } from '../stores/auth.js'
import { useAuctionStore } from '../stores/auction.js'
import { useNow } from '../stores/clock.js'
import { itemView } from '../lib/itemView.js'
import { formatMoney } from '../lib/auction.js'
import { createUserCache, fetchAllBids, winnersCsv, bidsCsv } from '../lib/admin.js'
import { downloadText, stamp } from '../lib/download.js'
import AdminControls from '../components/admin/AdminControls.vue'
import AdminImport from '../components/admin/AdminImport.vue'
import AdminItemRow from '../components/admin/AdminItemRow.vue'

const auth = useAuthStore()
const auction = useAuctionStore()
const now = useNow()
const lookupUser = createUserCache(db)

const filter = ref('all')
const exporting = ref('')
const exportError = ref('')

const rows = computed(() => {
  if (!auction.settings) return []
  const ctx = { settings: auction.settings, uid: auth.user?.uid, myBidItemIds: new Set(), now: now.value }
  return auction.items.map((item) => ({ item, view: itemView(item, ctx) }))
})

const stats = computed(() => {
  const r = rows.value
  const withBids = r.filter((x) => x.item.bidCount > 0)
  return {
    items: r.length,
    withBids: withBids.length,
    bids: r.reduce((s, x) => s + x.item.bidCount, 0),
    ended: r.filter((x) => x.view.ended).length,
    closing: r.filter((x) => x.view.status === 'closing').length,
    bidders: new Set(withBids.map((x) => x.item.highBidderUid)).size,
    total: withBids.reduce((s, x) => s + x.item.currentAmount, 0),
    currency: r[0]?.item.currency ?? '',
  }
})

const statCards = computed(() => [
  ['Items', stats.value.items],
  ['With bids', stats.value.withBids],
  ['Total bids', stats.value.bids],
  ['Leading bidders', stats.value.bidders],
  ['Ended', `${stats.value.ended} / ${stats.value.items}`],
  ['Current total', formatMoney(stats.value.currency, stats.value.total)],
])

const visible = computed(() =>
  rows.value.filter(({ item, view }) =>
    filter.value === 'all' ? true
      : filter.value === 'open' ? !view.ended
        : filter.value === 'ended' ? view.ended
          : filter.value === 'nobids' ? item.bidCount === 0
            : true),
)

async function usersFor(uids) {
  const entries = await Promise.all([...new Set(uids.filter(Boolean))].map(async (uid) => [uid, await lookupUser(uid)]))
  return new Map(entries.filter(([, u]) => u))
}

async function exportWinners() {
  exporting.value = 'winners'
  exportError.value = ''
  try {
    const users = await usersFor(auction.items.map((i) => i.highBidderUid))
    downloadText(`winners_${stamp()}.csv`, winnersCsv(auction.items, auction.settings, users, now.value))
  } catch (e) {
    console.error(e)
    exportError.value = 'Export failed.'
  } finally {
    exporting.value = ''
  }
}

// Reads every bid document once (one read per bid).
async function exportBids() {
  exporting.value = 'bids'
  exportError.value = ''
  try {
    const bids = await fetchAllBids(db)
    const users = await usersFor(bids.map((b) => b.uid))
    downloadText(`bids_${stamp()}.csv`, bidsCsv(bids, auction.itemsById, users))
  } catch (e) {
    console.error(e)
    exportError.value = 'Export failed.'
  } finally {
    exporting.value = ''
  }
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-xl font-semibold">Admin</h1>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          :disabled="!!exporting || !auction.items.length"
          class="rounded-md bg-white px-3 py-1.5 text-sm font-medium ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-40"
          @click="exportWinners"
        >
          {{ exporting === 'winners' ? 'Exporting…' : 'Winners CSV' }}
        </button>
        <button
          type="button"
          :disabled="!!exporting || !stats.bids"
          :title="`Reads ${stats.bids} bid documents`"
          class="rounded-md bg-white px-3 py-1.5 text-sm font-medium ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-40"
          @click="exportBids"
        >
          {{ exporting === 'bids' ? 'Exporting…' : 'All bids CSV' }}
        </button>
      </div>
    </div>
    <p v-if="exportError" class="text-sm text-rose-700">{{ exportError }}</p>

    <dl v-if="auction.settings" class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <div v-for="s in statCards" :key="s[0]" class="rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <dt class="text-xs text-slate-500">{{ s[0] }}</dt>
        <dd class="text-lg font-semibold tabular-nums">{{ s[1] }}</dd>
      </div>
    </dl>

    <div class="grid gap-4 lg:grid-cols-2">
      <AdminControls v-if="auction.settings" :settings="auction.settings" />
      <AdminImport :items="auction.items" :settings="auction.settings" :class="{ 'lg:col-span-2': !auction.settings }" />
    </div>

    <section v-if="auction.settings && auction.items.length" class="rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
      <div class="flex flex-wrap items-center justify-between gap-2 p-4">
        <h2 class="font-semibold">
          Items
          <span v-if="stats.closing" class="ml-2 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">{{ stats.closing }} closing soon</span>
        </h2>
        <select v-model="filter" aria-label="Filter items" class="rounded-md border border-slate-300 px-2 py-1 text-sm">
          <option value="all">All items</option>
          <option value="open">Open</option>
          <option value="ended">Ended</option>
          <option value="nobids">No bids</option>
        </select>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-left text-xs text-slate-500 uppercase">
            <tr>
              <th class="px-3 py-2">Lot</th>
              <th class="px-3 py-2">Item</th>
              <th class="px-3 py-2 text-right">Price</th>
              <th class="px-3 py-2 text-right">Bids</th>
              <th class="px-3 py-2">Leading bidder</th>
              <th class="px-3 py-2">Closes</th>
              <th class="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            <AdminItemRow
              v-for="r in visible"
              :key="r.item.id"
              :item="r.item"
              :view="r.view"
              :settings="auction.settings"
              :now="now"
              :lookup-user="lookupUser"
            />
          </tbody>
        </table>
      </div>
      <p v-if="auction.settings.biddingOpen" class="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
        Reset is available only while bidding is paused.
      </p>
    </section>
  </div>
</template>
