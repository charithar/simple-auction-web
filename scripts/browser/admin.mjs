#!/usr/bin/env node
// Admin page in headless Chrome: stats, bid history, +5m (and the closing-time
// field following it), pause, reset, import with preview, CSV exports.
// CHANGES EMULATOR DATA (leaves bidding paused, re-imports items). Re-run `npm run seed` afterwards.
// Prereqs: emulators + `npm run seed` + `npm run smoke` + `npm run seed -- --admin-only smoke0@example.com` + `npm run dev`.
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { launch, signIn, waitForText, clickText, collectConsole, checker, sleep, OUT } from './helpers.mjs'

const { check, done } = checker()
const DL = join(OUT, 'downloads') // native separators: Chrome rejects mixed ones
rmSync(DL, { recursive: true, force: true })
mkdirSync(DL, { recursive: true })

// Auction file with one renamed item and one new item: the file that was seeded
// (AUCTION_FILE, set by run-all), else the same default as `npm run seed`.
const file = process.env.AUCTION_FILE ?? (existsSync('data/auction.yml') ? 'data/auction.yml' : 'data/auction.sample.yml')
const modified = readFileSync(file, 'utf8')
  .replace(/(- id: 1\n\s+title:) (.+)/, '$1 $2 (edited)')
  + '  - id: 99\n    title: Test Monitor\n    startingPrice: 1000\n'
writeFileSync(`${OUT}/modified-auction.yml`, modified)

const browser = await launch()
const page = await browser.newPage()
await page.setViewport({ width: 1400, height: 1000 })
const errors = collectConsole(page)
const cdp = await page.createCDPSession()
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL })

const rowText = (lot) => page.evaluate((l) => {
  const tr = [...document.querySelectorAll('tbody > tr')].find((r) => r.children[0]?.textContent.trim() === String(l))
  return tr?.innerText.replace(/\s+/g, ' ') ?? ''
}, lot)
const firstRowButton = (sel) => page.evaluate((s) => [...document.querySelectorAll('tbody > tr')][0].querySelector(s)?.click(), sel)

try {
  await signIn(browser, page, 'smoke0@example.com')
  await waitForText(page, 'Admin')
  await clickText(page, 'nav a', 'Admin')
  await waitForText(page, 'Leading bidder')
  await sleep(1000)
  await page.screenshot({ path: `${OUT}/admin.png` })
  check(/Items\s*\d+/.test(await page.$eval('dl', (e) => e.innerText)), 'stats render')
  const schedulePanel = () => page.evaluate(() =>
    [...document.querySelectorAll('section')].find((s) => s.innerText.includes('Closing times')).innerText)
  check(/Only before any bids: \d+ item\(s\) already have bids/.test(await schedulePanel()), 'closing times: refused while items have bids')

  // Bid history of lot 0 (the smoke test bids there).
  await page.evaluate(() => document.querySelector('tbody button[aria-expanded]').click())
  await waitForText(page, 'Bid history')
  await sleep(800)
  const history = await page.$$eval('tbody table tr', (r) => r.length)
  check(history > 0, `lot 0 bid history shows ${history} bid(s)`)

  // All-bids export while lot 0 still has bids (the reset below clears them).
  // Real (trusted) clicks: Chrome blocks a second download started by a
  // script's element.click(), as it would any "multiple downloads" without a gesture.
  const realClick = async (text) => {
    const buttons = await page.$$('button')
    for (const b of buttons) if ((await b.evaluate((e) => e.textContent.trim())) === text) return b.click()
    throw new Error(`No button "${text}"`)
  }
  // One read per bid: slower than the winners export, so wait for the file.
  await realClick('All bids CSV')
  let bidsFile
  for (let t = 0; t < 30 && !bidsFile; t++) {
    await sleep(500)
    bidsFile = readdirSync(DL).find((f) => f.startsWith('bids_') && f.endsWith('.csv'))
  }
  const bidRows = bidsFile ? readFileSync(`${DL}/${bidsFile}`, 'utf8').split('\r\n') : []
  check(!!bidsFile && bidRows[0].includes('Bidder email') && bidRows.length > 1, `all-bids CSV downloaded (${bidRows.length - 1} rows)`)

  // Bids per bidder: its totals row must add up to the all-bids export.
  await sleep(500)
  await realClick('Bids per bidder CSV')
  let countsFile
  for (let t = 0; t < 30 && !countsFile; t++) {
    await sleep(500)
    countsFile = readdirSync(DL).find((f) => f.startsWith('bids-per-bidder_') && f.endsWith('.csv'))
  }
  const countRows = countsFile ? readFileSync(`${DL}/${countsFile}`, 'utf8').split('\r\n') : []
  const totalBids = Number(countRows.at(-1)?.split(',')[2])
  check(
    !!countsFile && countRows[0].includes('Lot 0') && countRows.at(-1).startsWith('Total,') && totalBids === bidRows.length - 1,
    `bids-per-bidder CSV downloaded (${countRows.length - 2} bidder(s), ${totalBids} bids in total)`,
  )

  // +5m: the row and the closing-time field both move.
  const before = await page.$eval('#end-item-000', (i) => i.value)
  await firstRowButton('td:last-child button')
  await sleep(1500)
  const after = await page.$eval('#end-item-000', (i) => i.value)
  check(new Date(after) - new Date(before) === 5 * 60_000, `+5m moves the closing time (${before} → ${after})`)

  // End in 2m (e.g. to try anti-sniping): two-step confirm; the item then closes about 2 minutes from now.
  const clickInFirstRow = (label) => page.evaluate((l) => [...[...document.querySelectorAll('tbody > tr')][0].querySelectorAll('button')]
    .find((b) => b.textContent.trim() === l).click(), label)
  await clickInFirstRow('End in 2m')
  await clickInFirstRow('End in 2 min?')
  // Read the server, not the page (which shows the write at once), and wait for it:
  // the emulator can take a few seconds to commit late in a full run.
  const clicked = Date.now()
  let endsIn
  do {
    await sleep(250)
    const item0 = await (await fetch('http://127.0.0.1:8080/v1/projects/demo-auction/databases/(default)/documents/items/item-000',
      { headers: { Authorization: 'Bearer owner' } })).json()
    endsIn = Date.parse(item0.fields.endTime.timestampValue) - Date.now()
  } while (endsIn > 120_000 && Date.now() - clicked < 20_000)
  check(endsIn > 100_000 && endsIn <= 120_000,
    `"End in 2m" (confirmed) makes lot 0 close in ${Math.round(endsIn / 1000)} s (on the server after ${((Date.now() - clicked) / 1000).toFixed(1)} s)`)

  const resetBtn = 'td:last-child button:last-of-type'
  // A row's buttons stay disabled until its last write is confirmed.
  const rowIdle = () => page.waitForFunction(() => ![...document.querySelectorAll('tbody > tr')][0].querySelector('td:last-child button').disabled,
    { polling: 250, timeout: 20_000 })
  await rowIdle()
  check(await page.evaluate((s) => [...document.querySelectorAll('tbody > tr')][0].querySelector(s).disabled, resetBtn),
    'reset is disabled while bidding is open')

  await clickText(page, 'section button', 'Pause bidding')
  await clickText(page, 'section button', 'Pause for everyone?')
  await waitForText(page, 'Paused', 5000)
  check(true, 'bidding paused (two-step confirm)')

  await page.waitForFunction((s) => ![...document.querySelectorAll('tbody > tr')][0].querySelector(s).disabled, { polling: 250, timeout: 20_000 }, resetBtn)
  await firstRowButton(resetBtn)
  await sleep(200)
  await firstRowButton(resetBtn)
  await waitForText(page, 'No bids yet', 10_000)
  check(/Rs\. [\d,]+ 0 No bids/.test(await rowText(0)), 'reset clears lot 0 bids and restores the price')

  // Import with preview
  await (await page.$('input[type=file]')).uploadFile(`${OUT}/modified-auction.yml`)
  await waitForText(page, 'changed', 10_000)
  const preview = await page.evaluate(() =>
    [...document.querySelectorAll('section')].find((s) => s.innerText.includes('Import auction file')).innerText.replace(/\s+/g, ' '))
  check(/1 new/.test(preview) && /title ×1/.test(preview), 'import preview shows 1 new item and the title change')
  await page.screenshot({ path: `${OUT}/admin-import.png` })
  await clickText(page, 'section button', 'Apply import')
  await clickText(page, 'section button', 'Apply import now?')
  await waitForText(page, 'Imported:', 15_000)
  await sleep(800)
  check((await rowText(1)).includes('(edited)') && (await rowText(99)).includes('Test Monitor'), 'import applied (edited lot 1, new lot 99)')

  // Exports
  await realClick('Winners CSV')
  await sleep(2500)
  const files = readdirSync(DL)
  const winners = files.find((f) => f.startsWith('winners_'))
  const rows = winners ? readFileSync(`${DL}/${winners}`, 'utf8').split('\r\n') : []
  check(!!winners && rows[0].includes('Winner email') && rows.length > 1, `winners CSV downloaded (${rows.length - 1} rows)`)

  // Reset all bids (bidding is paused by now): two-step confirm, result, every row back to "No bids".
  // The data side (which fields reset, > 500 bids, the pause guard in the rules) is in tests/rules/admin.test.js.
  await clickText(page, 'button', 'Reset all bids')
  await clickText(page, 'button', 'Delete all')
  await waitForText(page, 'Reset done:', 15_000)
  const noBids = await page.$$eval('tbody > tr', (trs) => trs.every((r) => /No bids/.test(r.innerText)))
  check(noBids, 'reset all bids: every item is back to "No bids"')

  // Closing times (setup): no bids now, so one schedule sets every item, in lot order.
  const firstClose = new Date(Math.ceil((Date.now() + 3 * 3_600_000) / 60_000) * 60_000)
  const p2 = (n) => String(n).padStart(2, '0')
  const local = `${firstClose.getFullYear()}-${p2(firstClose.getMonth() + 1)}-${p2(firstClose.getDate())}T${p2(firstClose.getHours())}:${p2(firstClose.getMinutes())}`
  const type = (sel, value) => page.$eval(sel, (el, v) => {
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
  await type('#schedule-first', local)
  await type('#schedule-gap', '2m')
  await sleep(300)
  check(/Lot 0 closes .+, lot \d+ \(the last\)/.test(await schedulePanel()), 'closing times: the preview names the first and last lot')
  await clickText(page, 'button', 'Set closing times')
  await sleep(200)
  await clickText(page, 'button', 'closing times?')
  await waitForText(page, 'Closing times set for', 10_000)
  const docs = (await (await fetch('http://127.0.0.1:8080/v1/projects/demo-auction/databases/(default)/documents/items?pageSize=100',
    { headers: { Authorization: 'Bearer owner' } })).json()).documents
  const ends = docs.map((d) => [Number(d.fields.order.integerValue), Date.parse(d.fields.endTime.timestampValue)]).sort((a, b) => a[0] - b[0])
  check(ends.every(([, end], i) => end === firstClose.getTime() + i * 120_000),
    `closing times: ${ends.length} items set 2 min apart in lot order, from ${firstClose.toLocaleTimeString()}`)

  await clickText(page, 'nav a', 'Items')
  await waitForText(page, 'Bidding is currently closed', 5000)
  check(true, 'bidder page shows the paused banner')
} catch (e) {
  check(false, `unexpected failure: ${e.message}`)
  await page.screenshot({ path: `${OUT}/admin-error.png` }).catch(() => {})
} finally {
  await browser.close()
}
process.exit(done(errors) ? 1 : 0)
