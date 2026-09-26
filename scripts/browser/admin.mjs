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

// Auction file with one renamed item and one new item. Same default as `npm run seed`.
const file = existsSync('data/auction.yml') ? 'data/auction.yml' : 'data/auction.sample.yml'
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

  // +5m: the row and the closing-time field both move.
  const before = await page.$eval('#end-item-000', (i) => i.value)
  await firstRowButton('td:last-child button')
  await sleep(1500)
  const after = await page.$eval('#end-item-000', (i) => i.value)
  check(new Date(after) - new Date(before) === 5 * 60_000, `+5m moves the closing time (${before} → ${after})`)

  const resetBtn = 'td:last-child button:last-of-type'
  check(await page.evaluate((s) => [...document.querySelectorAll('tbody > tr')][0].querySelector(s).disabled, resetBtn),
    'reset is disabled while bidding is open')

  await clickText(page, 'section button', 'Pause bidding')
  await clickText(page, 'section button', 'Pause for everyone?')
  await waitForText(page, 'Paused', 5000)
  check(true, 'bidding paused (two-step confirm)')

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
