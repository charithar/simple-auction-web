#!/usr/bin/env node
// Emergency stop (settings/killswitch) in headless Chrome: the admin turns it on;
// a bid from an already-open bidder page is refused with "temporarily
// unavailable"; a reload shows no items; the admin still sees everything; after
// "Resume access" the bidder signs in again and sees prices.
// Prereqs: emulators + `npm run seed` + `npm run smoke` + `npm run seed -- --admin-only smoke0@example.com` + `npm run dev`.
import { launch, signIn, waitForText, clickText, checker, APP_URL } from './helpers.mjs'

// Start from "off", even if an earlier failed run left it on (emulator REST, owner access).
await fetch('http://127.0.0.1:8080/v1/projects/demo-auction/databases/(default)/documents/settings/killswitch', {
  method: 'DELETE', headers: { Authorization: 'Bearer owner' },
})

const { check, done } = checker()
const browser = await launch()
const ctx = async (email) => {
  const c = await browser.createBrowserContext()
  const page = await c.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await signIn(browser, page, email)
  return page
}
const text = (page) => page.evaluate(() => document.body.innerText)
try {
  const admin = await ctx('smoke0@example.com')
  const bidder = await ctx('smoke1@example.com')
  await admin.goto(`${APP_URL}#/admin`)
  await waitForText(admin, 'Emergency stop')
  check(/Emergency stop\s*Off/.test(await text(admin)), 'admin page shows the emergency stop as Off')

  await clickText(admin, 'button', 'Block all bidder access')
  await clickText(admin, 'button', 'Block every bidder now?')
  await waitForText(admin, 'On: only admins have access', 10_000)
  check(true, 'admin turns it on (two-step confirm)')

  // A page opened earlier keeps its live prices, but a bid is refused with the reason.
  await bidder.evaluate(() => [...document.querySelectorAll('main .grid > button')].find((b) => /Lot 2(\D|$)/.test(b.innerText)).click())
  await bidder.waitForSelector('dialog[open] #bid-amount')
  await bidder.waitForFunction(() => /^\d+$/.test(document.querySelector('#bid-amount')?.value ?? ''), { polling: 250, timeout: 10_000 })
  await bidder.click('dialog[open] button[type=submit]')
  await bidder.waitForSelector('dialog[open] [role=status]', { timeout: 20_000 })
  const msg = await bidder.$eval('dialog[open] [role=status]', (e) => e.innerText)
  check(msg === 'The auction is temporarily unavailable. Please try again later.', `a bid from an open page is refused: "${msg}"`)
  await bidder.keyboard.press('Escape')

  await bidder.reload({ waitUntil: 'networkidle2' })
  await waitForText(bidder, 'temporarily unavailable', 20_000)
  const afterReload = await text(bidder)
  check(!/Starting price|\d+ bids?/.test(afterReload), 'a reload while it is on shows no items, just "temporarily unavailable"')

  await admin.reload({ waitUntil: 'networkidle2' })
  await waitForText(admin, 'On: only admins have access', 15_000)
  const adminRows = await admin.$$eval('tbody > tr', (r) => r.length)
  check(adminRows >= 20, `the admin still sees the items while it is on (${adminRows} rows)`)
  await clickText(admin, 'button', 'Resume access')
  await clickText(admin, 'button', 'Let bidders back in?')
  await waitForText(admin, 'Off', 10_000)

  await signIn(browser, bidder, 'smoke1@example.com').catch(() => {}) // signed out by the refused profile sync
  await bidder.goto(APP_URL, { waitUntil: 'networkidle2' })
  await waitForText(bidder, 'Lot 0', 20_000)
  const priced = await bidder.$$eval('main .grid > button', (bs) => bs.filter((b) => /Starting price|\d+ bids?/.test(b.innerText)).length)
  check(priced > 0, `after resuming, the bidder sees prices again (${priced} cards)`)
} finally {
  await browser.close()
}
done()
