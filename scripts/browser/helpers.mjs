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
import { initializeApp } from 'firebase/app'
import { getAuth, connectAuthEmulator, GoogleAuthProvider, signInWithCredential } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator, doc, getDoc, setLogLevel } from 'firebase/firestore'
import { placeBid } from '../../src/lib/bids.js'

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
    // CI (GitHub's Linux runners) can't use Chrome's sandbox.
    args: ['--no-first-run', '--no-default-browser-check', ...(process.env.CI ? ['--no-sandbox'] : [])],
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

// ---- emulator data, as its owner (bypasses the rules; local emulator only) ----

const EMULATOR_DOCS = 'http://127.0.0.1:8080/v1/projects/demo-auction/databases/(default)/documents'
const OWNER = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }

// Moves an item's scheduled closing time to `ms` from now.
export async function setItemEndIn(itemId, ms) {
  const res = await fetch(`${EMULATOR_DOCS}/items/${itemId}?updateMask.fieldPaths=endTime`, {
    method: 'PATCH', headers: OWNER,
    body: JSON.stringify({ fields: { endTime: { timestampValue: new Date(Date.now() + ms).toISOString() } } }),
  })
  if (!res.ok) throw new Error(`setItemEndIn ${itemId}: ${res.status}`)
}

// Sets the auction's anti-snipe window (settings/auction) and returns the previous value.
export async function setAntiSnipeSeconds(seconds) {
  const url = `${EMULATOR_DOCS}/settings/auction`
  const before = await (await fetch(url, { headers: OWNER })).json()
  const res = await fetch(`${url}?updateMask.fieldPaths=antiSnipeSeconds`, {
    method: 'PATCH', headers: OWNER, body: JSON.stringify({ fields: { antiSnipeSeconds: { integerValue: String(seconds) } } }),
  })
  if (!res.ok) throw new Error(`setAntiSnipeSeconds: ${res.status}`)
  return Number(before.fields.antiSnipeSeconds.integerValue)
}

// Turns the emergency stop off (settings/killswitch), e.g. after a failed run.
export const clearKillSwitch = () => fetch(`${EMULATOR_DOCS}/settings/killswitch`, { method: 'DELETE', headers: OWNER })

// ---- a rival bidder in Node, bidding through the app's own placeBid ----

let rivals = 0
export async function rival(email = 'smoke3@example.com') {
  setLogLevel('silent')
  const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-auction' }, `rival-${++rivals}`)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const db = getFirestore(app)
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  const sub = email.split('@')[0]
  const { user } = await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub, email, email_verified: true })))
  return {
    uid: user.uid,
    // Bids one minimum step above the current price (also for a first bid); returns the amount.
    async bid(itemId) {
      const settings = (await getDoc(doc(db, 'settings', 'auction'))).data()
      const item = (await getDoc(doc(db, 'items', itemId))).data()
      const amount = item.currentAmount + (item.minIncrement ?? settings.minIncrement)
      await placeBid(db, { itemId, uid: user.uid, amount, settings, seenBidCount: item.bidCount })
      return amount
    },
  }
}

// The card for lot `n`: its text, price (digits only) and ring colour.
export const cardInfo = (page, n) => page.evaluate((n) => {
  const b = [...document.querySelectorAll('main .grid > button')].find((x) => new RegExp(`Lot ${n}(\\D|$)`).test(x.innerText))
  if (!b) return null
  return {
    text: b.innerText.replace(/\s+/g, ' '),
    price: b.innerText.match(/Rs\. [\d,]+/)?.[0].replace(/\D/g, ''),
    ring: b.className.match(/ring-(amber|emerald|rose|slate)-\d+/)?.[0],
    pulse: !!b.querySelector('.animate-pulse'),
  }
}, n)
