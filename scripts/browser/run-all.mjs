#!/usr/bin/env node
// Runs every browser check in order against the RUNNING emulators: seeds the
// sample data (data/auction.sample.yml, the same everywhere), creates the test
// accounts and the admin, starts the dev server in emulator mode, runs each
// e2e script on freshly seeded items, and stops the server. Exit code 1 if any
// script fails. `npm run e2e:all` wraps it in `firebase emulators:exec` (needs
// Java); CI runs that. With emulators already running (e.g. emulators:docker):
// `npm run e2e:run`. E2E_SKIP=webkit,timing skips scripts.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const SCRIPTS = ['bidder', 'outbid', 'phone', 'webkit', 'killswitch', 'timing', 'admin'] // admin last: it changes data
const skip = new Set((process.env.E2E_SKIP ?? '').split(',').filter(Boolean))
const isWin = process.platform === 'win32'
const APP_URL = 'http://127.0.0.1:5173/'
const AUCTION_FILE = 'data/auction.sample.yml'
process.env.AUCTION_FILE = AUCTION_FILE // e2e:admin imports a variant of the seeded file

const run = (cmd, args, env = {}) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: isWin, env: { ...process.env, ...env } })
  p.on('exit', (code) => resolve(code ?? 1))
})
const npm = (...args) => run('npm', args)
const seed = () => npm('run', 'seed', '--', '--first-close', '60m', '--file', AUCTION_FILE)

async function startDevServer() {
  const server = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
    stdio: 'ignore', shell: isWin, detached: !isWin, env: { ...process.env, VITE_USE_EMULATORS: 'true' },
  })
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(APP_URL)).ok) return server
    } catch { /* not up yet */ }
    await sleep(1000)
  }
  throw new Error('dev server did not start')
}
function stop(server) {
  if (isWin) spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
  else process.kill(-server.pid)
}

const results = []
let server
try {
  if (await seed()) throw new Error('seed failed')
  if (await npm('run', 'smoke', '--', '--users', '6')) throw new Error('smoke failed') // smoke0..5
  if (await npm('run', 'seed', '--', '--admin-only', 'smoke0@example.com')) throw new Error('admin setup failed')
  server = await startDevServer()
  for (const name of SCRIPTS) {
    if (skip.has(name)) {
      results.push([name, 'skipped'])
      continue
    }
    console.log(`\n===== e2e:${name} =====`)
    await seed()
    if (name === 'admin') await npm('run', 'smoke', '--', '--users', '6') // e2e:admin expects the smoke bids on lot 0
    results.push([name, (await npm('run', `e2e:${name}`)) === 0 ? 'passed' : 'FAILED'])
  }
} catch (e) {
  console.error(e.message)
  results.push(['setup', 'FAILED'])
} finally {
  if (server) stop(server)
}

console.log('\n===== browser checks =====')
for (const [name, r] of results) console.log(`${r.padEnd(8)} ${name}`)
process.exit(results.some(([, r]) => r === 'FAILED') ? 1 : 0)
