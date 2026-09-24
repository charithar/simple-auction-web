// Shared helpers for the headless-Chrome checks in scripts/browser/.
// They drive the real app (npm run dev) against the LOCAL emulators and sign in
// through the Auth emulator's account picker. Nothing here touches a real project.
//
// Env: APP_URL (default http://127.0.0.1:5173/), CHROME_PATH (auto-detected),
//      HEADFUL=1 to watch the browser.
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

export const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
export const OUT = resolve('test-results/browser')
mkdirSync(OUT, { recursive: true })

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const log = (m) => console.log(m)

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  const found = candidates.find((p) => p && existsSync(p))
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH.')
  return found
}

// persistent: use a fresh profile dir so IndexedDB survives reloads within the run.
export const launch = ({ persistent = false } = {}) =>
  puppeteer.launch({
    executablePath: chromePath(),
    headless: !process.env.HEADFUL,
    args: ['--no-first-run', '--no-default-browser-check'],
    ...(persistent ? { userDataDir: mkdtempSync(join(tmpdir(), 'auction-e2e-')) } : {}),
  })

// Polls on an interval: background tabs don't get animation frames.
export const waitForText = (page, text, timeout = 20_000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout, polling: 250 }, text)

export async function clickText(page, selector, text) {
  const ok = await page.evaluate((s, t) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().includes(t))
    el?.click()
    return !!el
  }, selector, text)
  if (!ok) throw new Error(`No ${selector} containing "${text}"`)
}

// Signs in on `page` by picking `email` in the Auth emulator popup (the account
// must exist: run `npm run smoke` once to create smoke0..N@example.com).
export async function signIn(browser, page, email) {
  await page.goto(APP_URL, { waitUntil: 'networkidle2' })
  await waitForText(page, 'Sign in with Google')
  const popupP = new Promise((res) => browser.once('targetcreated', async (t) => res(await t.page())))
  await clickText(page, 'main button', 'Sign in with Google')
  const popup = await popupP
  await popup.waitForSelector('li.js-reuse-account', { timeout: 15_000 })
  // The list renders before its click handlers are bound: retry until the popup closes.
  for (let attempt = 0; attempt < 3 && !popup.isClosed(); attempt++) {
    await sleep(1000)
    for (const li of await popup.$$('li.js-reuse-account').catch(() => [])) {
      if ((await li.evaluate((e) => e.textContent)).includes(email)) {
        await li.click().catch(() => {})
        break
      }
    }
    await sleep(1500)
  }
  if (!popup.isClosed()) throw new Error(`Could not sign in as ${email} (does the emulator account exist?)`)
  await waitForText(page, 'Lot 0')
}

export const livePriceCount = (page) =>
  page.$$eval('main .grid > button', (bs) => bs.filter((b) => !b.querySelector('[aria-label="Loading price"]')).length)

// Collects console errors/warnings and page errors, ignoring the noise the checks
// cause on purpose (offline mode) and known-broken external images.
export function collectConsole(page) {
  const errors = []
  page.on('console', (m) => {
    if (!['error', 'warn'].includes(m.type())) return
    const t = m.text()
    if (/ERR_INTERNET_DISCONNECTED|transport errored|status of 404/.test(t)) return
    errors.push(`${m.type()}: ${t}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

// Counts the Firestore listen targets a page adds (each costs reads on a real project).
export function trackListens(page) {
  const s = { posts: 0, targets: 0, resumed: 0 }
  page.on('request', (req) => {
    if (!req.url().includes('/Listen/channel') || req.method() !== 'POST') return
    s.posts++
    const body = decodeURIComponent((req.postData() ?? '').replace(/\+/g, ' '))
    for (const m of body.matchAll(/"addTarget":\{(.*?)"targetId"/g)) {
      s.targets++
      if (/"resumeToken"/.test(m[1])) s.resumed++
    }
  })
  s.reset = () => Object.assign(s, { posts: 0, targets: 0, resumed: 0 })
  return s
}

// Minimal assertion bookkeeping shared by the scripts.
export function checker() {
  let failures = 0
  const check = (ok, msg) => {
    log(`${ok ? '✔' : '✘'} ${msg}`)
    if (!ok) failures++
  }
  const done = (errors = []) => {
    if (errors.length) {
      log(`console errors (${errors.length}):\n  ${errors.slice(0, 10).join('\n  ')}`)
      failures++
    }
    log(failures ? `\n${failures} check(s) failed. Screenshots: ${OUT}` : `\nAll checks passed. Screenshots: ${OUT}`)
    return failures
  }
  return { check, done }
}
