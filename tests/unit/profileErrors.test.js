import { describe, it, expect, vi, beforeEach } from 'vitest'

// syncProfile / checkAdmin error paths with a scripted Firestore: which errors
// are recovered from, and which must reach the caller (who then signs out).
const fs = { updateDoc: vi.fn(), setDoc: vi.fn(), getDocFromServer: vi.fn(), getDoc: vi.fn() }
vi.mock('firebase/firestore', () => ({
  doc: (db, ...path) => ({ path: path.join('/') }),
  serverTimestamp: () => 'server-time',
  updateDoc: (...a) => fs.updateDoc(...a),
  setDoc: (...a) => fs.setDoc(...a),
  getDocFromServer: (...a) => fs.getDocFromServer(...a),
  getDoc: (...a) => fs.getDoc(...a),
}))

const { syncProfile, checkAdmin, profileName } = await import('../../src/lib/profile.js')

const err = (code) => Object.assign(new Error(code), { code })
const snap = (data) => ({ exists: () => data != null, data: () => data })
const user = { uid: 'u1', email: 'ann@example.com', displayName: 'Ann' }

beforeEach(() => Object.values(fs).forEach((f) => f.mockReset()))

describe('syncProfile errors', () => {
  it('an unexpected error on the lastSeen touch reaches the caller', async () => {
    fs.updateDoc.mockRejectedValue(err('unavailable'))
    await expect(syncProfile({}, user)).rejects.toMatchObject({ code: 'unavailable' })
    expect(fs.setDoc).not.toHaveBeenCalled()
  })

  it('a missing doc reported as not-found is created', async () => {
    fs.updateDoc.mockRejectedValue(err('not-found'))
    fs.getDocFromServer.mockResolvedValueOnce(snap(null)).mockResolvedValueOnce(snap({ name: 'Ann', lastSeen: { toMillis: () => Date.now() } }))
    fs.setDoc.mockResolvedValue()
    const { profile, clockOffsetMs } = await syncProfile({}, user)
    expect(fs.setDoc).toHaveBeenCalledWith({ path: 'users/u1' }, expect.objectContaining({ name: 'Ann', email: 'ann@example.com' }))
    expect(profile.name).toBe('Ann')
    expect(Math.abs(clockOffsetMs)).toBeLessThan(1000)
  })

  it('an unexpected error while creating reaches the caller', async () => {
    fs.updateDoc.mockRejectedValue(err('permission-denied'))
    fs.getDocFromServer.mockResolvedValue(snap(null))
    fs.setDoc.mockRejectedValue(err('unavailable'))
    await expect(syncProfile({}, user)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('a refused create with still no profile is a real refusal, not a race', async () => {
    fs.updateDoc.mockRejectedValue(err('permission-denied'))
    fs.getDocFromServer.mockResolvedValue(snap(null))
    fs.setDoc.mockRejectedValue(err('permission-denied'))
    await expect(syncProfile({}, user)).rejects.toMatchObject({ code: 'permission-denied' })
    expect(fs.getDocFromServer).toHaveBeenCalledTimes(2)
  })
})

describe('checkAdmin', () => {
  it('true only when admins/{uid} exists; a failed read counts as not admin', async () => {
    fs.getDoc.mockResolvedValueOnce(snap({}))
    expect(await checkAdmin({}, 'u1')).toBe(true)
    fs.getDoc.mockResolvedValueOnce(snap(null))
    expect(await checkAdmin({}, 'u1')).toBe(false)
    fs.getDoc.mockRejectedValueOnce(err('permission-denied'))
    expect(await checkAdmin({}, 'u1')).toBe(false)
  })
})

describe('profileName', () => {
  it('display name, else the email prefix, else "Bidder"; trimmed and capped at 80', () => {
    expect(profileName({ displayName: '  Ann  ', email: 'x@y' })).toBe('Ann')
    expect(profileName({ displayName: '', email: 'bob@example.com' })).toBe('bob')
    expect(profileName({ displayName: null, email: null })).toBe('Bidder')
    expect(profileName({ displayName: 'x'.repeat(100) })).toHaveLength(80)
  })
})
