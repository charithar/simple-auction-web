import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseDomains, emailAllowed, allowedDomainsText } from '../../src/lib/access.js'
import { renderRules, RULES_TEMPLATE } from '../../scripts/build-rules.mjs'

const domains = ['allowed.test']

describe('parseDomains', () => {
  it('splits, trims, lowercases and dedupes', () => {
    expect(parseDomains(' Allowed.test, @other.test ,allowed.test,')).toEqual(['allowed.test', 'other.test'])
  })
  it('is empty when unset', () => {
    expect(parseDomains(undefined)).toEqual([])
    expect(parseDomains('')).toEqual([])
  })
  it('rejects anything that is not a plain domain (it ends up in a rules regex)', () => {
    for (const bad of ['allowed', 'a.test)|.*', 'a test.com', '*.test', 'user@a.test', '-a.test']) {
      expect(() => parseDomains(bad)).toThrow(/not a domain/)
    }
  })
})

describe('emailAllowed', () => {
  it('accepts the allowed domains, ignoring case', () => {
    expect(emailAllowed('dan@allowed.test', { domains })).toBe(true)
    expect(emailAllowed('Dan@ALLOWED.TEST', { domains })).toBe(true)
  })
  it('rejects other and lookalike domains', () => {
    for (const email of ['dan@gmail.com', 'dan@notallowed.test', 'dan@allowed.test.evil.com', 'allowed.test', '', null, undefined]) {
      expect(emailAllowed(email, { domains })).toBe(false)
    }
  })
  it('lets nobody in when no domains are configured', () => {
    expect(emailAllowed('dan@allowed.test', { domains: [] })).toBe(false)
  })
  it('accepts emulator test accounts only on the emulator', () => {
    expect(emailAllowed('smoke0@example.com', { domains })).toBe(false)
    expect(emailAllowed('smoke0@example.com', { domains, emulator: true })).toBe(true)
  })
  it('describes the domains for messages', () => {
    expect(allowedDomainsText(['a.test', 'b.test'])).toBe('@a.test or @b.test')
  })
})

describe('renderRules', () => {
  const template = readFileSync(RULES_TEMPLATE, 'utf8')
  it('fills the domains into allowedEmail() as an escaped regex', () => {
    const out = renderRules(template, ['a.test', 'b-c.test'])
    expect(out).toContain("email.matches('.*@(a[.]test|b-c[.]test)$')")
    expect(out).not.toContain('__ALLOWED_DOMAINS__')
    // Nothing else changes (a string replacement would expand the "$'" in the regex).
    expect(out.split('(a[.]test|b-c[.]test)').join('(__ALLOWED_DOMAINS__)')).toBe(template)
  })
  it('renders no domains as false (emulator accounts only)', () => {
    expect(renderRules(template, [])).toMatch(/&& \(false\n/)
  })
  it('fails loudly when the placeholder is missing', () => {
    expect(() => renderRules('rules_version = "2";', domains)).toThrow(/placeholder/)
  })
})
