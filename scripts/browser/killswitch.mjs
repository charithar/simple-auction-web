#!/usr/bin/env node
// Emergency stop (settings/killswitch) in headless Chrome: the admin turns it on;
// a bid from an already-open bidder page is refused with "temporarily
// unavailable"; a reload shows no items; the admin still sees everything; after
// "Resume access" pages recover by themselves (a reloaded one, and an open one
// whose listeners were refused), without a reload or sign-in, and show bids
// placed elsewhere.
// Prereqs: emulators + `npm run seed` + `npm run smoke` + `npm run seed -- --admin-only smoke0@example.com` + `npm run dev`.
import { initializeApp } from 'firebase/app'
import { getAuth, connectAuthEmulator, GoogleAuthProvider, signInWithCredential } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator, doc, getDoc, setLogLevel } from 'firebase/firestore'
import { launch, signIn, waitForText, clickText, checker, sleep, APP_URL } from './helpers.mjs'
import { placeBid } from '../../src/lib/bids.js'

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
// A rival bidding from elsewhere (Node, the app's own placeBid).
setLogLevel('silent')
const rivalApp = initializeApp({ apiKey: 'demo-key', projectId: 'demo-auction' }, 'rival')
const rivalAuth = getAuth(rivalApp)
connectAuthEmulator(rivalAuth, 'http://127.0.0.1:9099', { disableWarnings: true })
const rivalDb = getFirestore(rivalApp)
connectFirestoreEmulator(rivalDb, '127.0.0.1', 8080)
const { user: rival } = await signInWithCredential(rivalAuth,
  GoogleAuthProvider.credential(JSON.stringify({ sub: 'smoke3', email: 'smoke3@example.com', email_verified: true })))
async function rivalBid(itemId) {
  const settings = (await getDoc(doc(rivalDb, 'settings', 'auction'))).data()
  const item = (await getDoc(doc(rivalDb, 'items', itemId))).data()
  const step = item.minIncrement ?? settings.minIncrement
  const amount = item.currentAmount + step // above the current price, also for a first bid
  await placeBid(rivalDb, { itemId, uid: rival.uid, amount, settings, seenBidCount: item.bidCount })
  return amount
}
const card = (page, lot) => page.evaluate((lot) => [...document.querySelectorAll('main .grid > button')]
  .find((b) => new RegExp(`Lot ${lot}(\\D|$)`).test(b.innerText))?.innerText.match(/Rs\. [\d,]+/)?.[0].replace(/\D/g, ''), lot)
const header = (page) => page.evaluate(() => document.querySelector('nav').innerText)

try {
  const admin = await ctx('smoke0@example.com')
  const bidder = await ctx('smoke1@example.com')
  const watcher = await ctx('smoke2@example.com') // stays open, never reloads
  await admin.goto(`${APP_URL}#/admin`)
  await waitForText(admin, 'Emergency stop')
  check(/Emergency stop\s*Off/.test(await text(admin)), 'admin page shows the emergency stop as Off')

  await clickText(admin, 'button', 'Block all bidder access')
  await clickText(admin, 'button', 'Block every bidder now?')
  await waitForText(admin, 'On: only admins have access', 10_000)
  check(true, 'admin turns it on (two-step confirm)')

  // On the live site the stop also cuts open listeners; the emulator doesn't, so
  // force the watcher's listeners to re-attach under the stop (sign-in state
  // flips, same account, through the dev build's Pinia), as a reconnect would.
  await watcher.evaluate(() => {
    const auth = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('auth')
    const u = auth.user
    auth.user = null
    setTimeout(() => (auth.user = u), 50)
  })
  await waitForText(watcher, 'reconnects by itself', 15_000)
  check(/Reconnecting…/.test(await header(watcher)), 'an open page whose listeners are refused shows "reconnects by itself" and "Reconnecting…"')

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
  check(!/Starting price|\d+ bids?/.test(afterReload) && /Reconnecting…/.test(afterReload) && !/Sign in with Google/.test(afterReload),
    'a reload while it is on shows "temporarily unavailable … reconnects by itself", no items, and stays signed in')

  await admin.reload({ waitUntil: 'networkidle2' })
  await waitForText(admin, 'On: only admins have access', 15_000)
  const adminRows = await admin.$$eval('tbody > tr', (r) => r.length)
  check(adminRows >= 20, `the admin still sees the items while it is on (${adminRows} rows)`)
  await clickText(admin, 'button', 'Resume access')
  await clickText(admin, 'button', 'Let bidders back in?')
  await waitForText(admin, 'Off', 10_000)

  // No reload, no sign-in: the page retries (5 s, 15 s, then every 60 s) and comes back by itself.
  const t0 = Date.now()
  await waitForText(bidder, 'Lot 0', 75_000)
  const priced = await bidder.$$eval('main .grid > button', (bs) => bs.filter((b) => /Starting price|\d+ bids?/.test(b.innerText)).length)
  const banner = /temporarily unavailable/.test(await text(bidder))
  check(priced > 0 && !banner, `after resuming, the same page recovers by itself in ${Math.round((Date.now() - t0) / 1000)} s (${priced} cards, banner gone)`)

  // The watcher (listeners refused, never reloaded) must go Live again by itself,
  // even though nothing changed (the server only confirms its cached data)...
  const t1 = Date.now()
  await watcher.waitForFunction(() => /Live/.test(document.querySelector('nav').innerText)
    && !/reconnects by itself/.test(document.body.innerText), { polling: 250, timeout: 75_000 })
  check(true, `after resuming, the refused open page is Live again by itself in ${Math.round((Date.now() - t1) / 1000)} s`)
  // ...and then show bids placed elsewhere.
  const amount = await rivalBid('item-004')
  let shown
  for (let i = 0; i < 20 && shown !== String(amount); i++) {
    shown = await card(watcher, 4)
    if (shown !== String(amount)) await sleep(500)
  }
  check(shown === String(amount), `a bid placed elsewhere (Rs. ${amount}) reaches that page (shows ${shown})`)
} finally {
  await browser.close()
}
done()
process.exit(0) // the rival's Firestore client would keep Node alive
