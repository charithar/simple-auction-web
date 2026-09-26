#!/usr/bin/env node
// Closing time, as two bidders see it (about 3 minutes). A's device clock runs
// 3 minutes fast; the app corrects it with the server clock offset.
// - final minutes: amber ring and pulsing countdown; A and B show the same time
// - anti-sniping: B bids, A outbids B in the last seconds, the item is extended
//   for both ("extended"), B gets outbid
// - a dialog left open through the close loses its form and says it closed
// - "Open" drops the closed item but keeps the extended one
// - after the extended close: "You won" + total for A, "Not won" for B
// Moves two items' closing times and sets a 30 s anti-snipe window itself
// (emulator REST; the window is restored afterwards).
// Prereqs: emulators + `npm run seed` + `npm run smoke` + `npm run dev`.
import { launch, signIn, waitForText, clickText, checker, sleep, setItemEndIn, setAntiSnipeSeconds, cardInfo } from './helpers.mjs'

const { check, done } = checker()
const browser = await launch()
const SKEW_MS = 3 * 60_000
const ANTI_SNIPE_S = 30 // short, so B's early bid doesn't extend and the run stays short
let antiSnipeBefore = null

async function bidder(email, skew = 0) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  if (skew) await page.evaluateOnNewDocument((s) => { const real = Date.now.bind(Date); Date.now = () => real() + s }, skew)
  await signIn(browser, page, email)
  return page
}
const secsLeft = (text) => {
  const m = /(?:(\d+)m )?(\d+)s left/.exec(text ?? '')
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : null
}
async function openLot(page, n) {
  await page.evaluate((n) => [...document.querySelectorAll('main .grid > button')]
    .find((b) => new RegExp(`Lot ${n}(\\D|$)`).test(b.innerText)).click(), n)
  await page.waitForSelector('dialog[open]', { timeout: 10_000 })
}
async function bidInDialog(page) {
  await page.waitForFunction(() => /^\d+$/.test(document.querySelector('#bid-amount')?.value ?? ''), { polling: 250, timeout: 10_000 })
  await page.click('dialog[open] button[type=submit]')
  await page.waitForSelector('dialog[open] [role=status]', { timeout: 15_000 })
  return page.$eval('dialog[open] [role=status]', (e) => e.innerText)
}
const closeDialog = async (page) => {
  await page.keyboard.press('Escape')
  await sleep(400)
}

try {
  antiSnipeBefore = await setAntiSnipeSeconds(ANTI_SNIPE_S)
  const A = await bidder('smoke1@example.com', SKEW_MS)
  const B = await bidder('smoke2@example.com')
  await setItemEndIn('item-002', 40_000)
  await setItemEndIn('item-001', 50_000)
  const t0 = Date.now()
  await sleep(1500)

  // Final minutes, and the same countdown on a 3-minutes-fast device.
  const [a1, b1, b5] = [await cardInfo(A, 1), await cardInfo(B, 1), await cardInfo(B, 5)]
  check(a1.ring === 'ring-amber-400' && a1.pulse && b1.ring === 'ring-amber-400' && b1.pulse,
    `lot 1 (under 2 min left) is highlighted with a pulsing countdown for both (${a1.ring}, ${b1.ring})`)
  check(b5.ring === 'ring-slate-200' && !b5.pulse, 'a lot with time left is not highlighted')
  const [sa, sb] = [secsLeft(a1.text), secsLeft(b1.text)]
  check(sa != null && Math.abs(sa - sb) <= 2, `A's clock is 3 min fast, yet both show the same time left (${sa}s vs ${sb}s)`)

  // B bids first, then keeps lot 2's dialog open through its close.
  await openLot(B, 1)
  const rb = await bidInDialog(B)
  check(/^Bid placed/.test(rb), `B bids on lot 1: "${rb}"`)
  await closeDialog(B)
  await openLot(B, 2)

  // A waits for the last seconds of lot 1, then outbids B: anti-sniping extends it.
  await A.waitForFunction(() => {
    const b = [...document.querySelectorAll('main .grid > button')].find((x) => /Lot 1(\D|$)/.test(x.innerText))
    const m = /(?:(\d+)m )?(\d+)s left/.exec(b.innerText)
    return m && Number(m[1] ?? 0) * 60 + Number(m[2]) <= 15
  }, { polling: 250, timeout: 90_000 })
  await openLot(A, 1)
  const ra = await bidInDialog(A)
  check(/^Bid placed/.test(ra), `A outbids B in the last seconds: "${ra}"`)
  await closeDialog(A)
  await sleep(1500)
  const [a2, b2] = [await cardInfo(A, 1), await cardInfo(B, 1)]
  check(/extended/.test(a2.text) && /extended/.test(b2.text) && secsLeft(b2.text) > 15,
    `anti-sniping: lot 1 now shows "extended" for both, closing in ${secsLeft(b2.text)}s`)
  check(a2.ring === 'ring-emerald-500' && b2.ring === 'ring-rose-500', `A is winning, B is outbid (${a2.ring}, ${b2.ring})`)

  // Lot 2 closes while B's dialog is open: the form goes and the dialog says so.
  await B.waitForFunction(() => /Bidding on this item has closed\./.test(document.querySelector('dialog[open]')?.innerText),
    { polling: 250, timeout: Math.max(5_000, 40_000 - (Date.now() - t0) + 5_000) })
  check(!(await B.$('dialog[open] #bid-amount')), 'lot 2 closes with its dialog open: no bid form, "Bidding on this item has closed."')
  await closeDialog(B)

  // "Open" drops the closed lot 2 but keeps lot 1 (past its scheduled end, but extended).
  await sleep(Math.max(0, 50_000 - (Date.now() - t0) + 1_000))
  await clickText(B, '[role=tab]', 'Open')
  await sleep(500)
  const openLots = await B.$$eval('main .grid > button', (bs) => bs.map((b) => b.innerText.match(/Lot (\d+)/)?.[1]))
  check(!openLots.includes('2') && openLots.includes('1'), '"Open" drops the closed lot 2 and keeps the extended lot 1')
  await clickText(B, '[role=tab]', 'All')

  // After the extended close: A won, B didn't.
  await waitForText(A, 'You won', 90_000)
  const [a3, b3] = [await cardInfo(A, 1), await cardInfo(B, 1)]
  check(/You won/.test(a3.text) && /Not won/.test(b3.text), 'after the extended close: "You won" for A, "Not won" for B')
  const summary = await A.evaluate(() => document.querySelector('main').innerText.match(/You won [^\n]*/)?.[0])
  check(/^You won \d+ items?: Rs\. [\d,]+ in total$/.test(summary ?? ''), `A's summary: "${summary}"`)
} finally {
  if (antiSnipeBefore != null) await setAntiSnipeSeconds(antiSnipeBefore)
  await browser.close()
}
done()
