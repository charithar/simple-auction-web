#!/usr/bin/env node
// Multiple tabs in one browser share ONE Firestore connection (multi-tab cache):
// extra tabs and reloads while another tab is open must not add listen targets.
// Prereqs: emulators + `npm run seed` + `npm run smoke` + `npm run dev`.
import { launch, signIn, waitForText, livePriceCount, trackListens, checker, sleep, APP_URL } from './helpers.mjs'

const { check, done } = checker()
const browser = await launch({ persistent: true })

try {
  const a = await browser.newPage()
  await a.setViewport({ width: 1280, height: 900 })
  const sa = trackListens(a)
  await signIn(browser, a, 'smoke1@example.com')
  await sleep(3000)
  check(sa.targets > 0, `tab A listens (${sa.targets} targets)`)

  const others = []
  for (const name of ['B', 'C']) {
    const p = await browser.newPage()
    await p.setViewport({ width: 1280, height: 900 })
    const s = trackListens(p)
    await p.goto(APP_URL, { waitUntil: 'domcontentloaded' })
    await waitForText(p, 'Lot 0')
    await sleep(3000)
    check(s.targets === 0, `tab ${name} adds no listen targets (${s.targets})`)
    check((await livePriceCount(p)) > 0, `tab ${name} still shows live prices (via tab A)`)
    others.push({ p, s })
  }

  // Reload a tab while others are open: served through the shared connection.
  const { p: pb, s: sb } = others[0]
  sb.reset()
  await pb.reload({ waitUntil: 'domcontentloaded' })
  await waitForText(pb, 'Lot 0')
  await sleep(3000)
  check(sb.targets === 0, `reloading tab B adds no listen targets (${sb.targets})`)
} catch (e) {
  check(false, `unexpected failure: ${e.message}`)
} finally {
  await browser.close()
}
process.exit(done() ? 1 : 0)
