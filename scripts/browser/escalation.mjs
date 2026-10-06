#!/usr/bin/env node
// Raised minimum increment, as the admin and a bidder see it: the admin switches it
// on; at exactly the threshold nothing changes; once a rival takes the price over
// it, the bidder's open dialog raises its minimum by itself (without explaining why), a bid
// below the raised minimum can't be sent, one at it goes through; the admin's
// checks refuse bad values; switched off, the normal minimum is back.
// Uses Lot 3 (item-003: starting price 7500, increment 250, so over 125% = above 9375).
// Clears the setting afterwards.
// Prereqs: emulators + `npm run seed` + `npm run smoke` + admin for smoke0 + `npm run dev`.
import {
  launch, signIn, waitForText, clickText, collectConsole, checker, sleep, OUT, rival, setItemPrice, clearEscalation,
} from './helpers.mjs'

const ITEM = 'item-003'
const START = 7500
const STEP = 250
const THRESHOLD = START * 1.25 // 9375
const { check, done } = checker()
const browser = await launch()
let adminErrors = []
let pageErrors = []

const money = (n) => `Rs. ${n.toLocaleString('en-US')}`

try {
  await clearEscalation()
  await setItemPrice(ITEM, THRESHOLD)

  // Admin: the panel, off by default.
  const admin = await (await browser.createBrowserContext()).newPage()
  await admin.setViewport({ width: 1280, height: 900 })
  adminErrors = collectConsole(admin)
  await signIn(browser, admin, 'smoke0@example.com')
  await clickText(admin, 'nav a', 'Admin')
  await waitForText(admin, 'Raised minimum increment')
  const panel = () => admin.$eval('form[data-escalation]', (f) => f.innerText)
  const saveButton = () => admin.$eval('form[data-escalation] button[type=submit]', (b) => b.disabled)
  const type = async (sel, value) => {
    await admin.$eval(sel, (el, v) => {
      el.value = v
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, value)
    await sleep(200)
  }
  check(/\bOff\b/.test(await panel()), 'admin: off by default')
  check(await admin.$eval('#escalation-percent', (i) => i.value) === '25' && await admin.$eval('#escalation-factor', (i) => i.value) === '2',
    'admin: the form shows the defaults (25%, ×2)')
  check(await saveButton(), 'admin: Save is disabled until something changes')

  // Bad values are refused with the reason.
  await type('#escalation-factor', '1')
  check(/multiplier must be a whole number from 2 to 10/.test(await panel()) && await saveButton(), 'admin: a multiplier of 1 is refused')
  await type('#escalation-factor', '2')
  await type('#escalation-percent', '2.5')
  check(/percentage must be a whole number/.test(await panel()) && await saveButton(), 'admin: a fractional percentage is refused')
  await type('#escalation-percent', '25')

  // Switch it on.
  await admin.click('#escalation-enabled')
  await sleep(200)
  check(/Not saved yet/.test(await panel()) && !(await saveButton()), 'admin: ticking "On" can be saved')
  await admin.click('form[data-escalation] button[type=submit]')
  const on = await admin.waitForFunction(() => document.querySelector('form[data-escalation]').innerText.includes('On: 2× once over 125% of the starting price'),
    { polling: 250, timeout: 10_000 }).then(() => true, () => false)
  check(on, 'admin: saved, the badge says "On: 2× once over 125% of the starting price"')

  // Bidder: exactly at the threshold, the normal minimum.
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  pageErrors = collectConsole(page)
  await signIn(browser, page, 'smoke1@example.com')
  await page.waitForSelector('main .grid > button')
  await (await page.evaluateHandle(() => [...document.querySelectorAll('main .grid > button')].find((b) => /Lot 3(\D|$)/.test(b.innerText)))).click()
  await page.waitForSelector('dialog[open] #bid-amount')
  await sleep(500)
  const dialogText = () => page.$eval('dialog[open]', (d) => d.innerText)
  const prefill = () => page.$eval('#bid-amount', (i) => i.value)
  check(await prefill() === String(THRESHOLD + STEP), `at exactly 125% the minimum is the normal one (${await prefill()})`)

  // A rival takes the price over the threshold: the open dialog raises its minimum.
  const other = await rival('smoke3@example.com')
  const rivalAmount = await other.bid(ITEM)
  check(rivalAmount === THRESHOLD + STEP, `the rival bids ${rivalAmount}`)
  const raisedMin = rivalAmount + 2 * STEP
  const raised = await page.waitForFunction((v) => document.querySelector('#bid-amount')?.value === v, { polling: 250, timeout: 10_000 }, String(raisedMin))
    .then(() => true, () => false)
  check(raised, `the open dialog raises its pre-filled minimum by itself to ${raisedMin}`)
  check(!/starting price|go up by/i.test(await dialogText()), "the dialog doesn't explain the raised minimum to the bidder")
  check((await dialogText()).includes(`Minimum ${money(raisedMin)}`), `it states the minimum (${money(raisedMin)})`)
  await page.screenshot({ path: `${OUT}/escalation-raised.png` })

  // Below the raised minimum (the old step): refused before sending.
  await page.$eval('#bid-amount', (el, v) => {
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, String(rivalAmount + STEP))
  await sleep(200)
  const submitDisabled = await page.$eval('dialog[open] button[type=submit]', (b) => b.disabled)
  check(submitDisabled && (await dialogText()).includes(`Minimum bid is ${money(raisedMin)}.`), 'the old step is refused in the dialog, with the minimum')
  const refused = await other.bid(ITEM, { amount: raisedMin - 1 }).then(() => 'accepted', (e) => e.code)
  check(refused === 'too-low', `a bid one under the raised minimum is refused (${refused})`)

  // At the raised minimum: goes through.
  await page.$eval('#bid-amount', (el, v) => {
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, String(raisedMin))
  await sleep(200)
  await page.click('dialog[open] button[type=submit]')
  await waitForText(page, 'Bid placed', 10_000)
  check(true, `a bid at the raised minimum (${raisedMin}) goes through`)

  // Switched off: the normal minimum again, on the open page without a reload.
  await admin.click('#escalation-enabled')
  await sleep(200)
  await admin.click('form[data-escalation] button[type=submit]')
  const normal = await page.waitForFunction((v) => document.querySelector('dialog[open]')?.innerText.includes(v), { polling: 250, timeout: 10_000 },
    `Minimum ${money(raisedMin + STEP)}`).then(() => true, () => false)
  check(normal, 'switched off: the normal minimum is back')
  check(/\bOff\b/.test(await panel()), 'admin: the badge says Off')
} catch (e) {
  check(false, `unexpected failure: ${e.message}`)
} finally {
  await clearEscalation().catch(() => {})
}

await browser.close()
// Exit explicitly: the rival's Firestore client would keep Node alive.
process.exit(done([...adminErrors, ...pageErrors]) ? 1 : 0)
