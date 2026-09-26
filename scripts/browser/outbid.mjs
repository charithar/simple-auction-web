#!/usr/bin/env node
// Two bidders in headless Chrome: A bids and sees the "Winning" summary; B outbids
// A; A gets the outbid toast, whose "Bid again" opens the dialog, and the summary
// switches to "Outbid". Also checks the notification opt-in after a bid.
// Prereqs: emulators + `npm run seed` + `npm run smoke` + `npm run dev`.
import { launch, signIn, waitForText, collectConsole, checker, sleep } from './helpers.mjs'

const { check, done } = checker()
const browser = await launch()
const LOT = 3

async function bidder(email) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  const errors = collectConsole(page)
  await signIn(browser, page, email)
  return { page, errors }
}

async function openLot(page, n) {
  await page.evaluate((n) => [...document.querySelectorAll('main .grid > button')]
    .find((b) => new RegExp(`Lot ${n}(\\D|$)`).test(b.innerText)).click(), n)
  await page.waitForSelector('dialog[open] #bid-amount')
  await page.waitForFunction(() => /^\d+$/.test(document.querySelector('#bid-amount')?.value ?? ''), { polling: 250, timeout: 10_000 })
}

async function bid(page) {
  await page.click('dialog[open] button[type=submit]')
  await page.waitForSelector('dialog[open] [role=status]', { timeout: 15_000 })
  return page.$eval('dialog[open] [role=status]', (e) => e.innerText)
}

const text = (page) => page.evaluate(() => document.querySelector('main').innerText)
// "Outbid on N" in the summary (0 if absent). Counts rather than fixed numbers:
// `npm run smoke` leaves the smoke accounts with bids of their own.
const outbidCount = async (page) => Number((await text(page)).match(/Outbid on (\d+): bid again\?/)?.[1] ?? 0)

try {
  const A = await bidder('smoke1@example.com')
  const B = await bidder('smoke2@example.com')

  await openLot(A.page, LOT)
  const ra = await bid(A.page)
  check(/^Bid placed/.test(ra), `A bids on lot ${LOT}: "${ra}"`)
  const offer = await A.page.evaluate(() => [...document.querySelectorAll('dialog[open] button')].some((b) => /Notify me if I'm outbid/.test(b.innerText)))
  const permission = await A.page.evaluate(() => ('Notification' in window ? Notification.permission : 'unsupported'))
  check(offer === (permission === 'default'), `notification opt-in offered after a bid only while undecided (permission=${permission}, offered=${offer})`)
  await A.page.keyboard.press('Escape')
  await waitForText(A.page, 'if they close now')
  check(/Winning \d+ items? · Rs\. [\d,]+ if they close now/.test(await text(A.page)), 'A sees "Winning …" with its total')
  const outbidBefore = await outbidCount(A.page)

  await openLot(B.page, LOT)
  const rb = await bid(B.page)
  check(/^Bid placed/.test(rb), `B outbids A: "${rb}"`)

  await A.page.waitForSelector('[aria-live] [role=status]', { timeout: 10_000 })
  const toast = await A.page.$eval('[aria-live] [role=status]', (e) => e.innerText)
  check(/^Outbid on .+: the price is now Rs\. [\d,]+\./.test(toast), `A gets the outbid toast: "${toast.split('\n')[0]}"`)
  const outbidAfter = await outbidCount(A.page)
  check(outbidAfter === outbidBefore + 1, `A's summary counts the new outbid (${outbidBefore} → ${outbidAfter})`)

  await A.page.evaluate(() => [...document.querySelectorAll('[aria-live] button')].find((b) => b.innerText === 'Bid again').click())
  await A.page.waitForSelector('dialog[open] #bid-amount', { timeout: 5_000 })
  const title = await A.page.$eval('dialog[open]', (d) => d.innerText)
  check(new RegExp(`Lot ${LOT}(\\D|$)`).test(title), '"Bid again" opens that item\'s dialog')
  await sleep(300)
  check(!(await A.page.$('[aria-live] [role=status]')), 'the toast is dismissed')

  const errors = [...A.errors, ...B.errors].filter((e) => !/403|permission-denied/.test(e))
  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
done()
