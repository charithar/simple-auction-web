#!/usr/bin/env node
// A bidder on a phone (390x844, touch): the whole journey with taps. No sideways
// scrolling, every card priced after scrolling through, the bid form visible
// without scrolling in the dialog, a bid, the outbid toast fitting the screen
// with a working "Bid again", the dialog's close button, the "My bids" filter.
// Prereqs: emulators + `npm run seed` + `npm run smoke` + `npm run dev`.
import { launch, signIn, checker, sleep, OUT, rival } from './helpers.mjs'

const { check, done } = checker()
const browser = await launch()
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
const tapLot = async (n) => {
  const cards = await page.$$('main .grid > button')
  for (const c of cards) if (new RegExp(`Lot ${n}(\\D|$)`).test(await c.evaluate((e) => e.innerText))) return c.tap()
  throw new Error(`No card for lot ${n}`)
}
const inView = (sel) => page.$eval(sel, (e) => {
  const r = e.getBoundingClientRect()
  return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth
})

try {
  await signIn(browser, page, 'smoke4@example.com')
  await sleep(1000)
  check(await noSideScroll(), 'no sideways scrolling on the grid')

  // Scroll through the whole grid: every card has its price.
  const total = await page.$$eval('main .grid > button', (b) => b.length)
  for (let y = 0; y < 20; y++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8))
    await sleep(150)
  }
  const priced = await page.$$eval('main .grid > button', (bs) => bs.filter((b) => /Starting price|\d+ bids?/.test(b.innerText)).length)
  check(priced === total && total > 0, `every card shows its price after scrolling through (${priced} of ${total})`)
  check(await noSideScroll(), 'no sideways scrolling at the bottom either')
  await page.evaluate(() => window.scrollTo(0, 0))
  await sleep(300)

  // Tap a card: the bid form is visible without scrolling; bid.
  await tapLot(6)
  await page.waitForSelector('dialog[open] #bid-amount')
  await page.waitForFunction(() => /^\d+$/.test(document.querySelector('#bid-amount')?.value ?? ''), { polling: 250, timeout: 10_000 })
  check(await inView('dialog[open] button[type=submit]'), 'the bid button is on screen without scrolling the dialog')
  await page.tap('dialog[open] button[type=submit]')
  await page.waitForSelector('dialog[open] [role=status]', { timeout: 15_000 })
  const placed = await page.$eval('dialog[open] [role=status]', (e) => e.innerText)
  check(/^Bid placed/.test(placed), `a tap on the bid button places the bid: "${placed}"`)
  await page.tap('dialog[open] button[aria-label="Close"]')
  await sleep(500)
  check(!(await page.$('dialog[open]')), 'the dialog closes with its ✕ button')

  // Outbid from elsewhere: the toast fits the phone screen and "Bid again" works.
  const rivalBidder = await rival()
  await rivalBidder.bid('item-006')
  await page.waitForSelector('[aria-live] [role=status]', { timeout: 10_000 })
  check(await inView('[aria-live] [role=status]'), 'the outbid toast fits on the phone screen')
  const again = await page.$$('[aria-live] button')
  for (const b of again) if ((await b.evaluate((e) => e.innerText)) === 'Bid again') await b.tap()
  await page.waitForSelector('dialog[open] #bid-amount', { timeout: 5_000 })
  check(/Lot 6(\D|$)/.test(await page.$eval('dialog[open]', (d) => d.innerText)), '"Bid again" opens the item on the phone')
  await page.screenshot({ path: `${OUT}/phone-dialog.png` })
  await page.tap('dialog[open] button[aria-label="Close"]')
  await sleep(400)

  // Filters: "My bids" lists the item.
  const tabs = await page.$$('[role=tab]')
  for (const t of tabs) if (/^My bids/.test(await t.evaluate((e) => e.innerText))) await t.tap()
  await sleep(400)
  const mine = await page.$$eval('main .grid > button', (bs) => bs.map((b) => b.innerText.match(/Lot (\d+)/)?.[1]))
  check(mine.includes('6'), `"My bids" on the phone lists lot 6 (${mine.length} item(s))`)
  check(await noSideScroll(), 'still no sideways scrolling')
} finally {
  await browser.close()
}
done()
process.exit(0) // the rival's Firestore client would keep Node alive
