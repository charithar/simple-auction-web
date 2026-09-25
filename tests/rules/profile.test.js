// Runs against the Firestore emulator: npm run test:rules / npm run test:docker.
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, setLogLevel, Timestamp } from 'firebase/firestore'
import { syncProfile, checkAdmin, profileName } from '../../src/lib/profile.js'

let env

const fbUser = (uid, over = {}) => ({
  uid, email: `${uid}@example.com`, displayName: `User ${uid}`, ...over,
})
const db = (uid) =>
  env.authenticatedContext(uid, {
    email: `${uid}@example.com`,
    email_verified: true,
    firebase: { sign_in_provider: 'google.com' },
  }).firestore()

beforeAll(async () => {
  setLogLevel('silent')
  env = await initializeTestEnvironment({
    projectId: 'demo-auction',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  })
})

afterAll(() => env?.cleanup())

beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'admins/admin'), {}))
})

describe('syncProfile', () => {
  it('creates the profile on first login', async () => {
    const { profile } = await syncProfile(db('alice'), fbUser('alice'))
    expect(profile).toMatchObject({ name: 'User alice', email: 'alice@example.com' })
    expect(profile.createdAt.toMillis()).toBe(profile.lastSeen.toMillis())
  })

  it('touches lastSeen on later logins and keeps createdAt and name', async () => {
    const hourAgo = Timestamp.fromMillis(Date.now() - 3_600_000)
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'users/alice'), {
      name: 'User alice', email: 'alice@example.com', createdAt: hourAgo, lastSeen: hourAgo,
    }))
    const { profile } = await syncProfile(db('alice'), fbUser('alice', { displayName: 'Changed' }))
    expect(profile.createdAt.toMillis()).toBe(hourAgo.toMillis())
    expect(profile.lastSeen.toMillis()).toBeGreaterThan(hourAgo.toMillis())
    expect(profile.name).toBe('User alice')
  })

  it('a second login within the cooldown still loads the profile', async () => {
    const first = await syncProfile(db('alice'), fbUser('alice'))
    const second = await syncProfile(db('alice'), fbUser('alice'))
    expect(second.profile).toMatchObject({ name: 'User alice', email: 'alice@example.com' })
    expect(second.profile.lastSeen.toMillis()).toBe(first.profile.lastSeen.toMillis())
    expect(second.clockOffsetMs).toBe(0)
  })

  it('measures a sane clock offset (emulator shares our clock)', async () => {
    const { clockOffsetMs } = await syncProfile(db('alice'), fbUser('alice'))
    expect(Math.abs(clockOffsetMs)).toBeLessThan(2000)
  })

  it('falls back to the email prefix when there is no display name', async () => {
    const { profile } = await syncProfile(db('bob'), fbUser('bob', { displayName: null }))
    expect(profile.name).toBe('bob')
  })

  it('cannot sync someone else\'s profile', async () => {
    await expect(syncProfile(db('alice'), fbUser('bob'))).rejects.toThrow()
    let exists
    await env.withSecurityRulesDisabled(async (ctx) => {
      exists = (await getDoc(doc(ctx.firestore(), 'users/bob'))).exists()
    })
    expect(exists).toBe(false)
  })
})

describe('checkAdmin', () => {
  it('is true only for users in admins/', async () => {
    expect(await checkAdmin(db('admin'), 'admin')).toBe(true)
    expect(await checkAdmin(db('alice'), 'alice')).toBe(false)
  })
  it('cannot probe other users\' admin status (returns false)', async () => {
    expect(await checkAdmin(db('alice'), 'admin')).toBe(false)
  })
})

describe('profileName', () => {
  it('trims and caps at 80 chars', () => {
    expect(profileName({ displayName: `  ${'x'.repeat(100)} ` })).toHaveLength(80)
  })
})
