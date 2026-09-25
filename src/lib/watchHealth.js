// Safety net for the per-item watches in stores/auction.js: finds watched items
// that should be live but aren't, so the store can re-attach them.
//
// watches: Map<id, { reasons: Map, unsub, attachedAt, repairs }>
// live:    Map<id, doc> of items that have live data
// Problems:
//   'no-listener'  someone wants the item, but no listener is attached
//   'no-data'      a listener has been attached for stuckMs without delivering
//                  the item (retried at most maxRepairs times, so a deleted
//                  item can't keep costing reads)
export function findStuck(watches, live, now, { stuckMs = 10_000, maxRepairs = 3 } = {}) {
  const out = []
  for (const [id, w] of watches) {
    if (w.reasons.size === 0) continue
    if (!w.unsub) out.push({ id, problem: 'no-listener' })
    else if (!live.has(id) && w.attachedAt != null && now - w.attachedAt >= stuckMs && (w.repairs ?? 0) < maxRepairs) {
      out.push({ id, problem: 'no-data' })
    }
  }
  return out
}
