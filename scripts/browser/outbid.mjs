#!/usr/bin/env node
// Two bidders in headless Chrome: A bids and sees the "Winning" summary; B outbids
// A; A gets the outbid toast, whose "Bid again" opens the dialog, and the summary
// switches to "Outbid". Also checks the notification opt-in after a bid.
// Prereqs: emulators + `npm run seed` + `npm run smoke` + `npm run dev`.
import { launch, signIn, waitForText, collectConsole, checker, sleep, APP_URL } from './helpers.mjs'

const { check, done } = checker()
const browser = await launch()
const LOT = 3

async function bidder(email) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  const errors = collectConsole(page)
  // Record the notifications the page creates (they still go to the real API).
  await page.evaluateOnNewDocument(() => {
    window.__notes = []
    const Real = window.Notification
    window.Notification = class extends Real {
      constructor(title, options) {
        super(title, options)
        window.__notes.push({ title, body: options?.body })
      }
    }
  })
  await signIn(browser, page, email)
  return { page, errors }
}

async function openLot(page, n) {
  await page.evaluate((n) => [...document.querySelectorAll('main .grid > button')]
    .find((b) => new RegExp(`Lot ${n}(\\D|$)`).test(b.innerText)).click(), n)
  await page.waitForSelector('dialog[open] #bid-amount', { timeout: 10_000 })
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
  // Allow notifications (what the browser prompt does), then click the offer: a sample is sent at once.
  await A.page.browserContext().overridePermissions(new URL(APP_URL).origin, ['notifications'])
  await A.page.evaluate(() => [...document.querySelectorAll('dialog[open] button')].find((b) => /Notify me if I'm outbid/.test(b.innerText)).click())
  await A.page.waitForFunction(() => /Outbid alerts are on: we just sent a sample/.test(document.querySelector('dialog[open]')?.innerText), { polling: 250, timeout: 5_000 })
  const sample = await A.page.evaluate(() => window.__notes)
  check(sample.length === 1 && sample[0].title === 'Outbid alerts are on', `allowing notifications sends a sample at once ("${sample[0]?.title}")`)
  await A.page.keyboard.press('Escape')
  await sleep(300) // a person takes longer than this to click the next item
  await waitForText(A.page, 'if they close now')
  check(/Winning \d+ items? · Rs\. [\d,]+ if they close now/.test(await text(A.page)), 'A sees "Winning …" with its total')
  const outbidBefore = await outbidCount(A.page)

  // A switches to another app: the browser window loses focus (headless pages
  // always report focus, so this is simulated on A's page).
  await A.page.evaluate(() => { document.hasFocus = () => false })
  await openLot(B.page, LOT)
  const rb = await bid(B.page)
  check(/^Bid placed/.test(rb), `B outbids A: "${rb}"`)
  await B.page.keyboard.press('Escape')
  await sleep(300)

  await A.page.waitForSelector('[aria-live] [role=status]', { timeout: 10_000 })
  const outbidNotes = (await A.page.evaluate(() => window.__notes)).filter((n) => n.title === 'You were outbid')
  check(outbidNotes.length === 1 && /^Outbid on .+: the price is now Rs\. [\d,]+\.$/.test(outbidNotes[0].body),
    `A (another app in front) gets a browser notification (${outbidNotes.length}): "${outbidNotes[0]?.body.replace(/Outbid on [^:]+:/, 'Outbid on <item>:')}"`)
  await A.page.evaluate(() => { document.hasFocus = () => true }) // back to the auction
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

  // A keeps the dialog open after bidding; B outbids A: the green "Bid placed"
  // message must turn into "You've been outbid" with the live price.
  await A.page.keyboard.press('Escape')
  await sleep(300) // a person takes longer than this to click the next item
  const LOT2 = 5
  await openLot(A.page, LOT2)
  const ra2 = await bid(A.page)
  check(/^Bid placed/.test(ra2), `A bids on lot ${LOT2} and keeps the dialog open: "${ra2}"`)
  const status = () => A.page.$eval('dialog[open] [role=status]', (e) => ({ text: e.innerText, red: /rose/.test(e.className) }))
  for (const round of [1, 2]) {
    await openLot(B.page, LOT2)
    const rb2 = await bid(B.page)
    await B.page.keyboard.press('Escape')
  await sleep(300)
    await sleep(300)
    const price = rb2.match(/Rs\. [\d,]+/)?.[0]
    await A.page.waitForFunction((p) => document.querySelector('dialog[open] [role=status]')?.innerText.includes(`The price is now ${p}`),
      { polling: 250, timeout: 10_000 }, price)
    const s2 = await status()
    check(s2.red && /^You've been outbid\. The price is now Rs\. [\d,]+; the minimum bid is Rs\. [\d,]+\.$/.test(s2.text),
      `B outbids A (round ${round}): A's open dialog says "${s2.text}"`)
  }

  const errors = [...A.errors, ...B.errors].filter((e) => !/403|permission-denied/.test(e))
  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
done()
