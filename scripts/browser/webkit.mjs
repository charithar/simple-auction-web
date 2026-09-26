#!/usr/bin/env node
// Safari's engine (Playwright WebKit, emulating an iPhone 13): sign-in popup,
// every card priced, no sideways scrolling, a bid by tapping, then a rival's
// bid: the open dialog says "You've been outbid" and the outbid toast appears.
// Close to iPhone Safari, not identical: still try a real iPhone (README).
// One-time setup: npx playwright-core install webkit (CI adds --with-deps).
// Prereqs: emulators + `npm run seed` + `npm run smoke` + `npm run dev`.
import { webkit, devices } from 'playwright-core'
import { checker, sleep, APP_URL, OUT, rival } from './helpers.mjs'

const { check, done } = checker()
const browser = await webkit.launch({ headless: !process.env.HEADFUL })
const context = await browser.newContext({ ...devices['iPhone 13'] })
const page = await context.newPage()
const text = () => page.evaluate(() => document.body.innerText)

try {
  // Sign in through the Auth emulator's account picker (a popup, as on the live site).
  await page.goto(APP_URL)
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('main button', { hasText: 'Sign in with Google' }).click(),
  ])
  await popup.waitForSelector('li.js-reuse-account', { timeout: 15_000 })
  // The list renders before its click handlers are bound: retry until the popup closes.
  for (let i = 0; i < 5 && !popup.isClosed(); i++) {
    await sleep(1000)
    await popup.locator('li.js-reuse-account', { hasText: 'smoke4@example.com' }).first().click({ timeout: 3_000 }).catch(() => {})
    await sleep(1000)
  }
  await page.waitForFunction(() => document.body.innerText.includes('Lot 0'), null, { timeout: 20_000 })
  check(true, 'signs in through the popup')

  const cards = page.locator('main .grid > button')
  const total = await cards.count()
  const priced = await page.$$eval('main .grid > button', (bs) => bs.filter((b) => /Starting price|\d+ bids?/.test(b.innerText)).length)
  check(total > 0 && priced === total, `every card shows its price (${priced} of ${total})`)
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scrolling')

  // Tap a card and bid; keep the dialog open.
  await cards.filter({ hasText: /Lot 7(\D|$)/ }).tap()
  await page.waitForFunction(() => /^\d+$/.test(document.querySelector('dialog[open] #bid-amount')?.value ?? ''), null, { timeout: 10_000 })
  await page.locator('dialog[open] button[type=submit]').tap()
  const status = page.locator('dialog[open] [role=status]')
  await status.waitFor({ timeout: 15_000 })
  const placed = await status.innerText()
  check(/^Bid placed/.test(placed), `a tap places the bid: "${placed}"`)

  // A rival outbids: the open dialog and a toast say so.
  const rivalBidder = await rival()
  const amount = await rivalBidder.bid('item-007')
  const price = `Rs. ${amount.toLocaleString('en-US')}`
  await page.waitForFunction((p) => document.querySelector('dialog[open] [role=status]')?.innerText.includes(`The price is now ${p}`),
    price, { timeout: 10_000 })
  check(/^You've been outbid\./.test(await status.innerText()), `the open dialog says "You've been outbid" (price now ${price})`)
  check(/Outbid on .+: the price is now/.test(await text()), 'the outbid toast appears')
  await page.screenshot({ path: `${OUT}/webkit-iphone.png` })
} finally {
  await browser.close()
}
done()
process.exit(0) // the rival's Firestore client would keep Node alive
