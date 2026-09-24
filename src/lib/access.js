// Google accounts from these domains may use the app. Configured with the
// VITE_ALLOWED_DOMAINS environment variable (comma-separated), never in the repo.
// The same variable is rendered into the deployed Firestore rules by
// scripts/build-rules.mjs, which is the real enforcement.
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

export function parseDomains(value) {
  const list = String(value ?? '').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
  const bad = list.filter((d) => !DOMAIN.test(d))
  if (bad.length) throw new Error(`VITE_ALLOWED_DOMAINS: not a domain: ${bad.join(', ')}`)
  return [...new Set(list)]
}

// import.meta.env is undefined when plain Node imports this (scripts/build-rules.mjs).
export const ALLOWED_DOMAINS = parseDomains(import.meta.env?.VITE_ALLOWED_DOMAINS)

// Emulator test accounts (smoke/load scripts, rules tests) are @example.com.
// Only accepted on demo-* projects, which exist solely in the emulator.
export const EMULATOR_DOMAIN = 'example.com'

export const emailDomain = (email) => String(email ?? '').toLowerCase().split('@').pop()

export function emailAllowed(email, { domains = ALLOWED_DOMAINS, emulator = false } = {}) {
  if (!String(email ?? '').includes('@')) return false
  const domain = emailDomain(email)
  return domains.includes(domain) || (emulator && domain === EMULATOR_DOMAIN)
}

export const allowedDomainsText = (domains = ALLOWED_DOMAINS) => domains.map((d) => `@${d}`).join(' or ')
