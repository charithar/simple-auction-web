#!/usr/bin/env node
// Rapid reloads of one tab (lib/loadGuard.js): from the 3rd page load within a
// minute the app shows cached prices, adds NO listen targets, shows the
// "no need to refresh" banner, and goes live by itself after the cooldown.
// Takes ~1.5 minutes (waits out the 60 s cooldown).
// Prereqs: emulators + `npm run seed` + `npm run smoke` + `npm run dev`.
import { launch, signIn, waitForText, livePriceCount, trackListens, checker, sleep, OUT } from './helpers.mjs'

const { check, done } = checker()
const browser = await launch({ persistent: true })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
const s = trackListens(page)
const indicator = async () => /Live|Reconnecting…|Connecting…|Paused/.exec(await page.$eval('nav', (n) => n.innerText))?.[0]

try {
  await signIn(browser, page, 'smoke2@example.com') // page load 1
  await sleep(3000)
  const first = s.targets
  check(first > 0, `first load listens (${first} targets)`)

  for (let load = 2; load <= 5; load++) {
    s.reset()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForText(page, 'Lot 0')
    await sleep(3000)
    const text = await page.evaluate(() => document.body.innerText)
    const cooling = /live updates resume in \d+s/.test(text)
    if (load === 2) {
      check(!cooling && s.targets > 0 && s.targets < first,
        `load 2 goes live, skipping the cached profile/admin checks (${s.targets} < ${first} targets)`)
    } else {
      check(cooling && s.targets === 0 && (await indicator()) === 'Reconnecting…' && (await livePriceCount(page)) > 0,
        `load ${load}: cooldown with cached prices, 0 listen targets (${s.targets})`)
    }
  }
  await page.screenshot({ path: `${OUT}/reload-cooldown.png` })

  s.reset()
  await page.waitForFunction(() => !document.body.innerText.includes('live updates resume'), { timeout: 90_000, polling: 500 })
  await sleep(3000)
  check(s.targets > 0 && (await indicator()) === 'Live', `after the cooldown it goes live by itself (${s.targets} targets)`)
} catch (e) {
  check(false, `unexpected failure: ${e.message}`)
  await page.screenshot({ path: `${OUT}/reload-error.png` }).catch(() => {})
} finally {
  await browser.close()
}
process.exit(done() ? 1 : 0)
