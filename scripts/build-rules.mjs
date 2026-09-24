#!/usr/bin/env node
// Renders firestore.rules (a template) into .rules/firestore.rules, the file that
// firebase.json deploys and the emulator loads. The allowed sign-in domains come
// from VITE_ALLOWED_DOMAINS (environment, .env.local or .env), so they never
// live in the repo.
//
//   npm run rules                  # before emulators / rules tests (runs automatically)
//   npm run deploy:rules -- --project <id>   # renders with --require, then deploys
//
// Without domains only the emulator's @example.com accounts (demo-* projects) get
// in; --require refuses to render that, so a deploy can't lock everyone out.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { parseDomains } from '../src/lib/access.js'

export const RULES_TEMPLATE = 'firestore.rules'
export const RULES_OUT = '.rules/firestore.rules'
// Left as is, this condition matches no real email, so the raw template fails closed.
const PLACEHOLDER = "email.matches('.*@(__ALLOWED_DOMAINS__)$')"

export function renderRules(template, domains) {
  if (!template.includes(PLACEHOLDER)) throw new Error(`${RULES_TEMPLATE}: placeholder ${PLACEHOLDER} not found`)
  const cond = domains.length
    ? `email.matches('.*@(${domains.map((d) => d.replaceAll('.', '[.]')).join('|')})$')`
    : 'false'
  // A replacer function, because cond contains "$'" (a special pattern in string replacements).
  return template.replace(PLACEHOLDER, () => cond)
}

// realpath: on Windows argv[1] keeps the path's typed case, import.meta.url doesn't;
// a mismatch would silently skip the render and let deploy:rules ship a stale file.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { values: args } = parseArgs({ options: { require: { type: 'boolean', default: false } } })
  const { loadEnv } = await import('vite')
  const value = process.env.VITE_ALLOWED_DOMAINS ?? loadEnv('production', process.cwd(), 'VITE_').VITE_ALLOWED_DOMAINS
  const domains = parseDomains(value)
  if (args.require && !domains.length) {
    console.error('VITE_ALLOWED_DOMAINS is empty: set it in .env.local (e.g. VITE_ALLOWED_DOMAINS=example.org) before deploying.')
    process.exit(1)
  }
  mkdirSync(dirname(RULES_OUT), { recursive: true })
  writeFileSync(RULES_OUT, renderRules(readFileSync(RULES_TEMPLATE, 'utf8'), domains))
  console.log(`${RULES_OUT}: ${domains.length} allowed domain(s)${domains.length ? '' : ' (emulator accounts only)'}`)
}
