import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// firebase.js reads the build-time env when it loads, so each test stubs the
// VITE_* values and imports a fresh copy. The Firebase SDK is replaced by spies:
// nothing here touches the network.
const sdk = vi.hoisted(() => ({
  initializeApp: vi.fn((config) => ({ config })),
  getAuth: vi.fn(() => ({ name: 'auth' })),
  connectAuthEmulator: vi.fn(),
  getFirestore: vi.fn(() => ({ name: 'db' })),
  connectFirestoreEmulator: vi.fn(),
  initializeAppCheck: vi.fn(),
  providers: [],
}))
vi.mock('firebase/app', () => ({ initializeApp: sdk.initializeApp }))
vi.mock('firebase/auth', () => ({
  getAuth: sdk.getAuth,
  connectAuthEmulator: sdk.connectAuthEmulator,
  GoogleAuthProvider: class {
    constructor() {
      this.params = null
      sdk.providers.push(this)
    }
    setCustomParameters(p) {
      this.params = p
    }
  },
}))
vi.mock('firebase/firestore', () => ({ getFirestore: sdk.getFirestore, connectFirestoreEmulator: sdk.connectFirestoreEmulator }))
vi.mock('firebase/app-check', () => ({
  initializeAppCheck: sdk.initializeAppCheck,
  ReCaptchaEnterpriseProvider: class {
    constructor(key) {
      this.key = key
    }
  },
}))

async function load(env) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('../../src/firebase.js')
}

beforeEach(() => {
  vi.resetModules()
  for (const f of Object.values(sdk)) if (typeof f === 'function') f.mockClear()
  sdk.providers.length = 0
  vi.stubEnv('VITE_APPCHECK_SITE_KEY', '')
  vi.stubEnv('VITE_APPCHECK_DEBUG_TOKEN', '')
  vi.stubGlobal('self', {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('firebase.js', () => {
  it('production: the configured project, and Google offers only the one allowed domain (hd)', async () => {
    const mod = await load({
      VITE_USE_EMULATORS: 'false', VITE_FIREBASE_API_KEY: 'key', VITE_FIREBASE_PROJECT_ID: 'proj',
      VITE_FIREBASE_AUTH_DOMAIN: 'proj.example', VITE_FIREBASE_APP_ID: 'app', VITE_ALLOWED_DOMAINS: 'allowed.test',
    })
    expect(mod.useEmulators).toBe(false)
    expect(sdk.initializeApp).toHaveBeenCalledWith({ apiKey: 'key', authDomain: 'proj.example', projectId: 'proj', appId: 'app' })
    expect(sdk.connectAuthEmulator).not.toHaveBeenCalled()
    expect(sdk.connectFirestoreEmulator).not.toHaveBeenCalled()
    expect(mod.googleProvider.params).toEqual({ prompt: 'select_account', hd: 'allowed.test' })
    expect(sdk.initializeAppCheck).not.toHaveBeenCalled() // no site key
  })

  it('with several allowed domains there is no hd hint (Google can\'t take a list)', async () => {
    const mod = await load({ VITE_USE_EMULATORS: 'false', VITE_ALLOWED_DOMAINS: 'allowed.test,other.test' })
    expect(mod.googleProvider.params).toEqual({ prompt: 'select_account' })
  })

  it('emulators: the demo project, local Auth and Firestore, no hd hint and no App Check', async () => {
    const mod = await load({ VITE_USE_EMULATORS: 'true', VITE_FIREBASE_API_KEY: '', VITE_ALLOWED_DOMAINS: 'allowed.test', VITE_APPCHECK_SITE_KEY: 'site' })
    expect(mod.useEmulators).toBe(true)
    expect(sdk.initializeApp.mock.calls[0][0]).toMatchObject({ apiKey: 'demo-key', projectId: 'demo-auction' })
    expect(sdk.connectAuthEmulator).toHaveBeenCalledWith({ name: 'auth' }, 'http://127.0.0.1:9099', { disableWarnings: true })
    expect(sdk.connectFirestoreEmulator).toHaveBeenCalledWith({ name: 'db' }, '127.0.0.1', 8080)
    expect(mod.googleProvider.params).toEqual({ prompt: 'select_account' })
    expect(sdk.initializeAppCheck).not.toHaveBeenCalled()
  })

  it('a site key turns on App Check with reCAPTCHA Enterprise and token refresh', async () => {
    const mod = await load({ VITE_USE_EMULATORS: 'false', VITE_APPCHECK_SITE_KEY: 'site-key', DEV: false })
    expect(sdk.initializeAppCheck).toHaveBeenCalledTimes(1)
    const [app, options] = sdk.initializeAppCheck.mock.calls[0]
    expect(app).toBe(sdk.initializeApp.mock.results[0].value)
    expect(options).toMatchObject({ provider: { key: 'site-key' }, isTokenAutoRefreshEnabled: true })
    expect(mod.db).toEqual({ name: 'db' })
    expect(self.FIREBASE_APPCHECK_DEBUG_TOKEN).toBeUndefined() // never outside the dev server
  })

  it('the App Check debug token is used only on the dev server', async () => {
    await load({ VITE_USE_EMULATORS: 'false', VITE_APPCHECK_SITE_KEY: 'site-key', VITE_APPCHECK_DEBUG_TOKEN: 'dbg', DEV: true })
    expect(self.FIREBASE_APPCHECK_DEBUG_TOKEN).toBe('dbg')
    vi.resetModules()
    vi.stubGlobal('self', {})
    await load({ VITE_USE_EMULATORS: 'false', VITE_APPCHECK_SITE_KEY: 'site-key', VITE_APPCHECK_DEBUG_TOKEN: 'dbg', DEV: false })
    expect(self.FIREBASE_APPCHECK_DEBUG_TOKEN).toBeUndefined()
  })
})
