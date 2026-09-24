#!/usr/bin/env node
// Bidder flow in headless Chrome: sign-in, grid, lazy live prices, bidding,
// dialog URL, filters, mobile layout, offline banner.
// Prereqs: emulators + `npm run seed` + `npm run smoke` (creates the test accounts) + `npm run dev`.
import { launch, signIn, waitForText, clickText, livePriceCount, collectConsole, checker, sleep, OUT } from './helpers.mjs'

const { check, done } = checker()
const browser = await launch()
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
const errors = collectConsole(page)

try {
  await signIn(browser, page, 'smoke0@example.com')
  await sleep(1500)
  await page.screenshot({ path: `${OUT}/bidder-grid.png` })

  const cards = await page.$$eval('main .grid > button', (b) => b.length)
  const nav = await page.$eval('nav', (n) => n.innerText)
  check(cards > 0, `grid shows ${cards} items`)
  check(/Live/.test(nav), 'header shows the Live indicator')

  const liveTop = await livePriceCount(page)
  check(liveTop > 0 && liveTop < cards, `only cards near the screen are live (${liveTop} of ${cards})`)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await sleep(2000)
  const lastLive = await page.$$eval('main .grid > button', (bs) => !bs.at(-1).querySelector('[aria-label="Loading price"]'))
  check(lastLive, 'scrolling to the bottom makes the last card live')
  await page.evaluate(() => window.scrollTo(0, 0))
  await sleep(500)

  // Bid the suggested minimum on lot 1.
  const buttons = await page.$$('main .grid > button')
  await buttons[1].click()
  await page.waitForSelector('dialog[open] #bid-amount')
  await page.waitForFunction(() => document.querySelector('#bid-amount')?.value !== '', { polling: 250, timeout: 10_000 })
  await page.screenshot({ path: `${OUT}/bidder-dialog.png` })
  const amount = await page.$eval('#bid-amount', (i) => i.value)
  await page.click('dialog[open] button[type=submit]')
  await page.waitForSelector('dialog[open] [role=status]', { timeout: 15_000 })
  const status = await page.$eval('dialog[open] [role=status]', (e) => e.innerText)
  check(status.startsWith('Bid placed'), `bid of ${amount}: "${status}"`)
  check(page.url().includes('?item=item-001'), 'open item is in the URL')

  await page.keyboard.press('Escape')
  await sleep(500)
  check(!(await page.$('dialog[open]')) && !page.url().includes('item='), 'Esc closes the dialog and clears the URL')

  await clickText(page, '[role=tab]', 'My bids')
  await sleep(300)
  const mine = await page.$$eval('main .grid > button', (b) => b.length)
  check(mine >= 1, `"My bids" filter shows ${mine} item(s)`)
  await clickText(page, '[role=tab]', 'All')

  // Phone layout
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await sleep(800)
  await page.screenshot({ path: `${OUT}/bidder-mobile.png` })
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no horizontal scrolling on a phone')
  await (await page.$$('main .grid > button'))[0].click()
  await page.waitForSelector('dialog[open]')
  await sleep(800)
  await page.screenshot({ path: `${OUT}/bidder-mobile-dialog.png` })
  const formVisible = await page.$eval('dialog[open] #bid-amount', (el) => el.getBoundingClientRect().bottom <= window.innerHeight).catch(() => null)
  check(formVisible !== false, 'bid form is above the fold on a phone (or item closed)')

  // Offline
  await page.setOfflineMode(true)
  await sleep(500)
  const off = await page.evaluate(() => ({
    banner: document.body.innerText.includes("You're offline"),
    disabled: document.querySelector('dialog[open] button[type=submit]')?.disabled ?? true,
  }))
  check(off.banner && off.disabled, 'offline: banner shown and bidding disabled')
  await page.setOfflineMode(false)
  await sleep(800)
  check(!(await page.evaluate(() => document.body.innerText.includes("You're offline"))), 'back online: banner gone')
  await waitForText(page, 'Lot')
} catch (e) {
  check(false, `unexpected failure: ${e.message}`)
  await page.screenshot({ path: `${OUT}/bidder-error.png` }).catch(() => {})
} finally {
  await browser.close()
}
process.exit(done(errors) ? 1 : 0)
