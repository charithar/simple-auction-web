import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// stores/auth.js with Firebase Auth, the profile module and the domain check
// replaced: onAuthStateChanged hands its callback to the test, which then plays
// sign-in states through it.
const fb = { onAuthChanged: null, signInWithPopup: vi.fn(), signOut: vi.fn(async () => {}) }
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: vi.fn((auth, cb) => { fb.onAuthChanged = cb }),
  signInWithPopup: (...a) => fb.signInWithPopup(...a),
  signOut: (...a) => fb.signOut(...a),
}))
vi.mock('../../src/firebase.js', () => ({ auth: { name: 'auth' }, db: { name: 'db' }, googleProvider: {}, useEmulators: false }))
const access = { domains: '@allowed.test' }
vi.mock('../../src/lib/access.js', () => ({
  emailAllowed: (email) => String(email).endsWith('@allowed.test'),
  allowedDomainsText: () => access.domains,
}))
const profile = { syncProfile: vi.fn(), checkAdmin: vi.fn() }
vi.mock('../../src/lib/profile.js', () => ({
  syncProfile: (...a) => profile.syncProfile(...a),
  checkAdmin: (...a) => profile.checkAdmin(...a),
}))

const { useAuthStore, isInAppBrowser, storedOffset, storeOffset, httpDateOffset } = await import('../../src/stores/auth.js')

// In-memory localStorage for the stored clock offset.
const memoryStorage = () => {
  const m = new Map()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
const { onAuthStateChanged } = await import('firebase/auth')

const fbUser = (email = 'ann@allowed.test') => ({ uid: 'u1', email, photoURL: 'https://x/p.png' })

beforeEach(() => {
  setActivePinia(createPinia())
  fb.onAuthChanged = null
  fb.signInWithPopup.mockReset()
  fb.signOut.mockReset().mockResolvedValue()
  profile.syncProfile.mockReset().mockResolvedValue({ profile: { name: 'Ann' }, clockOffsetMs: 1234 })
  profile.checkAdmin.mockReset().mockResolvedValue(false)
  onAuthStateChanged.mockClear()
  access.domains = '@allowed.test'
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.unstubAllGlobals())

describe('auth store: auth states', () => {
  it('init subscribes once; no user makes it ready and signed out', async () => {
    const auth = useAuthStore()
    auth.init()
    auth.init()
    expect(onAuthStateChanged).toHaveBeenCalledTimes(1)
    expect(auth.ready).toBe(false)
    await fb.onAuthChanged(null)
    await expect(auth.whenReady()).resolves.toBeUndefined()
    expect(auth).toMatchObject({ ready: true, signedIn: false, user: null, isAdmin: false })
  })

  it('an allowed account: profile synced, admin checked, clock offset kept', async () => {
    profile.checkAdmin.mockResolvedValue(true)
    const auth = useAuthStore()
    auth.init()
    await fb.onAuthChanged(fbUser())
    expect(profile.syncProfile).toHaveBeenCalledWith({ name: 'db' }, expect.objectContaining({ uid: 'u1' }))
    expect(profile.checkAdmin).toHaveBeenCalledWith({ name: 'db' }, 'u1')
    expect(auth.user).toEqual({ uid: 'u1', name: 'Ann', email: 'ann@allowed.test', photoURL: 'https://x/p.png' })
    expect(auth).toMatchObject({ signedIn: true, isAdmin: true, clockOffsetMs: 1234, busy: false, ready: true, error: '' })
  })

  describe('clock offset across page loads', () => {
    beforeEach(() => (globalThis.localStorage = memoryStorage()))
    afterEach(() => delete globalThis.localStorage)

    it('a measured offset is stored, and reused when the next load cannot measure one', async () => {
      let auth = useAuthStore()
      auth.init()
      await fb.onAuthChanged(fbUser())
      expect(auth.clockOffsetMs).toBe(1234)
      expect(storedOffset()).toBe(1234)

      setActivePinia(createPinia()) // a quick reload: profile touched under a minute ago
      profile.syncProfile.mockResolvedValue({ profile: { name: 'Ann' }, clockOffsetMs: null })
      auth = useAuthStore()
      auth.init()
      await fb.onAuthChanged(fbUser())
      expect(auth.clockOffsetMs).toBe(1234)
    })

    it('a stored offset older than 12 hours, or a garbled one, is ignored', () => {
      storeOffset(900, Date.now() - 13 * 3_600_000)
      expect(storedOffset()).toBeNull()
      localStorage.setItem('auction.clockOffset', '{not json')
      expect(storedOffset()).toBeNull()
    })

    it("a new device with nothing stored falls back to the site's Date header", async () => {
      vi.stubGlobal('window', { location: { href: 'https://auction.test/' } })
      const serverNow = Date.now() - 180_000 // this device runs 3 minutes fast
      const fetchMock = vi.fn(async () => ({ headers: { get: (h) => (h === 'date' ? new Date(serverNow).toUTCString() : null) } }))
      vi.stubGlobal('fetch', fetchMock)
      profile.syncProfile.mockResolvedValue({ profile: { name: 'Ann' }, clockOffsetMs: null })
      const auth = useAuthStore()
      auth.init()
      await fb.onAuthChanged(fbUser())
      expect(fetchMock).toHaveBeenCalledWith('https://auction.test/', { method: 'HEAD', cache: 'no-store' })
      expect(Math.abs(auth.clockOffsetMs - -180_000)).toBeLessThan(1_600) // the header has second resolution
      vi.unstubAllGlobals()
    })

    it('blocked storage just means no stored offset', () => {
      globalThis.localStorage = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
      expect(() => storeOffset(5)).not.toThrow()
      expect(storedOffset()).toBeNull()
    })
  })

  it('an unmeasured clock offset (null) is used as 0', async () => {
    profile.syncProfile.mockResolvedValue({ profile: { name: 'Ann' }, clockOffsetMs: null })
    const auth = useAuthStore()
    auth.init()
    await fb.onAuthChanged(fbUser())
    expect(auth.clockOffsetMs).toBe(0)
  })

  it('another domain is signed out before any Firestore request, with the allowed domain named', async () => {
    const auth = useAuthStore()
    auth.init()
    await fb.onAuthChanged(fbUser('eve@gmail.com'))
    expect(profile.syncProfile).not.toHaveBeenCalled()
    expect(fb.signOut).toHaveBeenCalledTimes(1)
    expect(auth.error).toBe('Please sign in with your @allowed.test Google account.')
    expect(auth).toMatchObject({ signedIn: false, ready: true })
  })

  it('with no allowed domains configured, it says sign-in is not set up', async () => {
    access.domains = ''
    const auth = useAuthStore()
    auth.init()
    await fb.onAuthChanged(fbUser('eve@gmail.com'))
    expect(auth.error).toBe('Sign-in is not set up for this site yet (no allowed domains configured).')
  })

  describe('refused profile sync (emergency stop on)', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())
    const denied = () => Object.assign(new Error('denied'), { code: 'permission-denied' })

    it('keeps the Google session, says it reconnects, and retries until access is back', async () => {
      profile.syncProfile.mockRejectedValue(denied())
      const auth = useAuthStore()
      auth.init()
      await fb.onAuthChanged(fbUser())
      expect(auth.error).toBe('The auction is temporarily unavailable. This page reconnects by itself.')
      expect(auth).toMatchObject({ signedIn: false, retrying: true, busy: false, ready: true })
      expect(fb.signOut).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(5_000) // still refused
      expect(profile.syncProfile).toHaveBeenCalledTimes(2)
      profile.syncProfile.mockResolvedValue({ profile: { name: 'Ann' }, clockOffsetMs: 7 })
      await vi.advanceTimersByTimeAsync(14_999)
      expect(profile.syncProfile).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1) // 15 s after the second try: access is back
      expect(auth).toMatchObject({ signedIn: true, retrying: false, error: '', clockOffsetMs: 7 })
    })

    it('signing out (or another account) stops the retries', async () => {
      profile.syncProfile.mockRejectedValue(denied())
      const auth = useAuthStore()
      auth.init()
      await fb.onAuthChanged(fbUser())
      await fb.onAuthChanged(null)
      expect(auth.retrying).toBe(false)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(profile.syncProfile).toHaveBeenCalledTimes(1)
    })
  })

  it('a failed profile sync signs out and asks to sign in again', async () => {
    profile.syncProfile.mockRejectedValue(Object.assign(new Error('offline'), { code: 'unavailable' }))
    const auth = useAuthStore()
    auth.init()
    await fb.onAuthChanged(fbUser())
    expect(auth.error).toBe('Your profile could not be loaded. Please sign in again.')
    expect(fb.signOut).toHaveBeenCalledTimes(1)
    expect(auth).toMatchObject({ signedIn: false, isAdmin: false, busy: false, ready: true })
  })

  it('a failing Firebase sign-out is swallowed; the app state is still signed out', async () => {
    fb.signOut.mockRejectedValue(new Error('network'))
    const auth = useAuthStore()
    auth.init()
    await fb.onAuthChanged(fbUser('eve@gmail.com'))
    profile.syncProfile.mockRejectedValue(new Error('sync failed'))
    await fb.onAuthChanged(fbUser())
    await new Promise((r) => setTimeout(r, 0)) // let the rejected sign-outs settle
    expect(fb.signOut).toHaveBeenCalledTimes(2)
    expect(auth).toMatchObject({ signedIn: false, ready: true })
  })

  it('a slow profile sync for a previous auth state is ignored', async () => {
    let finish
    profile.syncProfile.mockReturnValue(new Promise((r) => (finish = r)))
    const auth = useAuthStore()
    auth.init()
    const first = fb.onAuthChanged(fbUser())
    expect(auth.busy).toBe(true)
    await fb.onAuthChanged(null) // signed out while the first sync was pending
    expect(auth.busy).toBe(false) // the header shows "Sign in", not "Loading…"
    finish({ profile: { name: 'Ann' }, clockOffsetMs: 5 })
    await first
    expect(auth).toMatchObject({ signedIn: false, user: null, clockOffsetMs: 0, busy: false })
  })

  it('a slow failing sync for a previous auth state doesn\'t sign the new user out', async () => {
    let fail
    profile.syncProfile.mockReturnValueOnce(new Promise((_, rej) => (fail = rej)))
    const auth = useAuthStore()
    auth.init()
    const first = fb.onAuthChanged(fbUser())
    await fb.onAuthChanged(fbUser()) // e.g. a second auth event; this sync succeeds
    fail(new Error('late failure'))
    await first
    expect(fb.signOut).not.toHaveBeenCalled()
    expect(auth).toMatchObject({ signedIn: true, error: '' })
  })
})

describe('auth store: sign-in and sign-out', () => {
  it('sign-in clears the previous error', async () => {
    fb.signInWithPopup.mockResolvedValue({})
    const auth = useAuthStore()
    auth.error = 'old'
    await auth.signIn()
    expect(auth.error).toBe('')
  })

  it('closing the popup is not an error', async () => {
    const auth = useAuthStore()
    for (const code of ['auth/popup-closed-by-user', 'auth/cancelled-popup-request']) {
      fb.signInWithPopup.mockRejectedValueOnce({ code })
      await auth.signIn()
      expect(auth.error).toBe('')
    }
    expect(console.error).not.toHaveBeenCalled()
  })

  it('known errors get their own message', async () => {
    const auth = useAuthStore()
    fb.signInWithPopup.mockRejectedValueOnce({ code: 'auth/popup-blocked' })
    await auth.signIn()
    expect(auth.error).toMatch(/blocked the sign-in popup/)
    fb.signInWithPopup.mockRejectedValueOnce({ code: 'auth/network-request-failed' })
    await auth.signIn()
    expect(auth.error).toMatch(/^Network error/)
  })

  it('an unknown error inside an in-app browser says to open Chrome or Safari', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/400.0]' })
    fb.signInWithPopup.mockRejectedValueOnce({ code: 'auth/internal-error' })
    const auth = useAuthStore()
    await auth.signIn()
    expect(auth.error).toBe('Sign-in does not work inside this app. Open the link in Chrome or Safari.')
  })

  it('an unknown error in a normal browser is a generic retry message', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' })
    fb.signInWithPopup.mockRejectedValueOnce({ code: 'auth/internal-error' })
    const auth = useAuthStore()
    await auth.signIn()
    expect(auth.error).toBe('Sign-in failed. Please try again.')
  })

  it('sign-out signs out of Firebase', async () => {
    await useAuthStore().signOut()
    expect(fb.signOut).toHaveBeenCalledWith({ name: 'auth' })
  })
})

describe('isInAppBrowser', () => {
  it.each([
    ['FBAN/FBIOS', true], ['Instagram 300', true], ['Line/13.1', true], ['MicroMessenger/8', true],
    ['Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit', true], ['Mozilla/5.0 (Macintosh) Safari/605', false],
  ])('%s → %s', (ua, expected) => {
    vi.stubGlobal('navigator', { userAgent: ua })
    expect(isInAppBrowser()).toBe(expected)
  })
})

describe('httpDateOffset', () => {
  const headers = (date) => ({ headers: { get: (h) => (h === 'date' ? date : null) } })
  it('estimates the offset from the Date header, taking the middle of its second', async () => {
    const times = [10_000, 10_200]
    vi.stubGlobal('fetch', vi.fn(async () => headers(new Date(70_000).toUTCString())))
    expect(await httpDateOffset('https://x/', () => times.shift())).toBe(70_000 + 500 - 10_100)
    vi.unstubAllGlobals()
  })
  it('null without a usable header, or when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => headers(null)))
    expect(await httpDateOffset('https://x/')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await httpDateOffset('https://x/')).toBeNull()
    vi.unstubAllGlobals()
  })
})
