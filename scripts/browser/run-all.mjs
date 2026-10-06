#!/usr/bin/env node
// Runs every browser check in order against the RUNNING emulators: seeds the
// sample data (data/auction.sample.yml, the same everywhere), creates the test
// accounts and the admin, starts the dev server in emulator mode, runs each
// e2e script on freshly seeded items, and stops the server. Exit code 1 if any
// script fails. `npm run e2e:all` wraps it in `firebase emulators:exec` (needs
// Java); CI runs that. With emulators already running (e.g. emulators:docker):
// `npm run e2e:run`. E2E_SKIP=webkit,timing skips scripts.
// Prints how long each step took; a script that runs longer than SCRIPT_LIMIT_MS
// is stopped and counted as failed, so a hang names itself instead of eating
// the whole CI job. The dev server's output goes to test-results/browser/.
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const SCRIPTS = ['bidder', 'outbid', 'phone', 'webkit', 'killswitch', 'timing', 'start', 'escalation', 'admin'] // admin last: it changes data
const SCRIPT_LIMIT_MS = 8 * 60_000
const skip = new Set((process.env.E2E_SKIP ?? '').split(',').filter(Boolean))
const isWin = process.platform === 'win32'
const APP_URL = 'http://127.0.0.1:5173/'
const AUCTION_FILE = 'data/auction.sample.yml'
process.env.AUCTION_FILE = AUCTION_FILE // e2e:admin imports a variant of the seeded file
const OUT = 'test-results/browser'
mkdirSync(OUT, { recursive: true })

const t0 = Date.now()
const stamp = () => {
  const s = Math.round((Date.now() - t0) / 1000)
  return `[${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}]`
}

// Runs a command; resolves its exit code (1 if it had to be stopped at `limitMs`).
function run(cmd, args, limitMs = 0) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: isWin, detached: !isWin })
    let timedOut = false
    const timer = limitMs && setTimeout(() => {
      timedOut = true
      console.error(`${stamp()} ${cmd} ${args.join(' ')}: still running after ${limitMs / 60_000} min, stopping it`)
      kill(p)
    }, limitMs)
    p.on('exit', (code) => {
      clearTimeout(timer)
      resolve(timedOut ? 1 : (code ?? 1))
    })
  })
}
function kill(child) {
  if (isWin) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
}
const npm = (args, limitMs) => run('npm', args, limitMs)
const seed = () => npm(['run', 'seed', '--', '--first-close', '60m', '--file', AUCTION_FILE], 2 * 60_000)

async function startDevServer() {
  const log = createWriteStream(`${OUT}/dev-server.log`)
  const server = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'], shell: isWin, detached: !isWin, env: { ...process.env, VITE_USE_EMULATORS: 'true' },
  })
  server.stdout.pipe(log)
  server.stderr.pipe(log)
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(APP_URL)).ok) return server
    } catch { /* not up yet */ }
    await sleep(1000)
  }
  throw new Error('dev server did not start (see test-results/browser/dev-server.log)')
}

const results = []
let server
try {
  console.log(`${stamp()} seeding ${AUCTION_FILE}, creating test accounts`)
  if (await seed()) throw new Error('seed failed')
  if (await npm(['run', 'smoke', '--', '--users', '6'], 3 * 60_000)) throw new Error('smoke failed') // smoke0..5
  if (await npm(['run', 'seed', '--', '--admin-only', 'smoke0@example.com'], 60_000)) throw new Error('admin setup failed')
  console.log(`${stamp()} starting the dev server`)
  server = await startDevServer()
  for (const name of SCRIPTS) {
    if (skip.has(name)) {
      results.push([name, 'skipped', 0])
      continue
    }
    console.log(`\n${stamp()} ===== e2e:${name} =====`)
    const start = Date.now()
    await seed()
    if (name === 'admin') await npm(['run', 'smoke', '--', '--users', '6'], 3 * 60_000) // e2e:admin expects the smoke bids on lot 0
    const code = await npm(['run', `e2e:${name}`], SCRIPT_LIMIT_MS)
    results.push([name, code === 0 ? 'passed' : 'FAILED', Date.now() - start])
  }
} catch (e) {
  console.error(`${stamp()} ${e.message}`)
  results.push(['setup', 'FAILED', 0])
} finally {
  if (server) kill(server)
}

console.log(`\n${stamp()} ===== browser checks =====`)
for (const [name, r, ms] of results) console.log(`${r.padEnd(8)} ${name.padEnd(11)} ${ms ? `${Math.round(ms / 1000)} s` : ''}`)
process.exit(results.some(([, r]) => r === 'FAILED') ? 1 : 0)
