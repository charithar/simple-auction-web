#!/usr/bin/env node
// Start time, as a bidder and as the admin sees it: before the start, prices are
// visible with "Opens in …", the dialog has no bid box and bids are refused; at the
// start, the open page switches to bidding by itself (no reload) and a bid goes
// through. Sets settings/auction.startTime itself and clears it afterwards.
// Prereqs: emulators + `npm run seed` + `npm run smoke` + admin for smoke0 + `npm run dev`.
import { launch, signIn, waitForText, clickText, collectConsole, checker, sleep, OUT, setStartIn, rival } from './helpers.mjs'

const START_IN = 45_000 // enough for two sign-ins through the account picker
const { check, done } = checker()
const browser = await launch()
let adminErrors = []
let pageErrors = []

try {
  await setStartIn(START_IN)
  const startsAt = Date.now() + START_IN

  // The admin's Bidding panel: switched on, opening at the start time.
  const admin = await (await browser.createBrowserContext()).newPage()
  await admin.setViewport({ width: 1280, height: 900 })
  adminErrors = collectConsole(admin)
  await signIn(browser, admin, 'smoke0@example.com')
  await clickText(admin, 'nav a', 'Admin')
  await waitForText(admin, 'Bidding starts')
  const panel = await admin.evaluate(() =>
    [...document.querySelectorAll('section')].find((s) => s.innerText.includes('Bidding starts')).innerText)
  check(/Opens at /.test(panel), `admin: the Bidding panel says "Opens at …"`)
  check(await admin.$eval('#start-time', (i) => /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(i.value)), 'admin: the start time is in its field')

  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  pageErrors = collectConsole(page)
  await signIn(browser, page, 'smoke1@example.com')
  await sleep(1000)
  const text = () => page.evaluate(() => document.body.innerText)
  check(/Bidding opens at .+\(in \d/.test(await text()), 'banner: "Bidding opens at … (in …)"')
  const cards = await page.$$eval('main .grid > button', (bs) => bs.map((b) => b.innerText))
  check(cards.length > 0 && cards.every((t) => /Opens in \d/.test(t)), `every card says "Opens in …" (${cards.length})`)
  check(cards.every((t) => /Starting price|\d+ bids?/.test(t)), 'prices are visible before the start')

  // Lot 1's dialog: the opening time instead of a bid box.
  await (await page.$$('main .grid > button'))[1].click()
  await page.waitForSelector('dialog[open]')
  await sleep(500)
  const dialog = await page.$eval('dialog[open]', (d) => d.innerText)
  check(/Bidding opens at/.test(dialog) && !(await page.$('dialog[open] #bid-amount')), 'the dialog shows the opening time and no bid box')
  await page.screenshot({ path: `${OUT}/start-before.png` })

  const other = await rival('smoke3@example.com')
  const refused = await other.bid('item-002').then(() => 'accepted', (e) => e.code)
  check(refused === 'not-started', `a bid before the start is refused (${refused})`)

  // The start: the open dialog gets its bid box by itself.
  await page.waitForFunction(() => !!document.querySelector('dialog[open] #bid-amount'), { polling: 250, timeout: START_IN + 15_000 })
  const late = Date.now() - startsAt
  check(late < 3_000, `at the start the open dialog shows the bid box by itself (${late} ms after)`)
  check(!/Bidding opens at/.test(await page.$eval('main', (m) => m.innerText)), 'the banner is gone')
  check((await page.$eval('#bid-amount', (i) => i.value)) !== '', 'the bid box is pre-filled with the minimum')

  await page.click('dialog[open] button[type=submit]')
  await waitForText(page, 'Bid placed', 10_000)
  check(true, 'a bid right after the start goes through')
  await page.keyboard.press('Escape')
  await sleep(300)
  const card = await page.$$eval('main .grid > button', (bs) => bs[2].innerText)
  check(/ left/.test(card) && !/Opens in/.test(card), 'cards show the time left again')
  check(await other.bid('item-002').then(() => true, () => false), "another bidder's bid goes through too")
  await admin.waitForFunction(() => /\bOpen\b/.test([...document.querySelectorAll('section')].find((s) => s.innerText.includes('Bidding starts')).innerText)
    && !/Opens at/.test(document.body.innerText), { polling: 250, timeout: 5_000 }).then(() => check(true, 'admin: the panel says "Open"'), () => check(false, 'admin: the panel says "Open"'))
  await page.screenshot({ path: `${OUT}/start-after.png` })
} catch (e) {
  check(false, `unexpected failure: ${e.message}`)
} finally {
  await setStartIn(null).catch(() => {})
}

await browser.close()
process.exit(done([...adminErrors, ...pageErrors]) ? 1 : 0)
