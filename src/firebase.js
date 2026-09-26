import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider, connectAuthEmulator } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { ALLOWED_DOMAINS } from './lib/access.js'

// Always import.meta.env.VITE_X, never `import.meta.env` on its own: Vite inlines
// each referenced value, but a bare import.meta.env becomes an object literal of
// EVERY VITE_* variable in .env.local, shipping values meant for local use only.
export const useEmulators = import.meta.env.VITE_USE_EMULATORS === 'true'

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'demo-key',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: useEmulators ? 'demo-auction' : import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
})

// Optional App Check (reCAPTCHA Enterprise, now "Fraud Defense"; Firebase no longer
// offers plain reCAPTCHA v3 for new apps): lets Firestore reject requests that don't come
// from this site, so scripts can't run up the read bill. Only active when a site
// key is configured; enforcement itself is switched on in the Firebase console.
// Must run before any Firestore/Auth request, hence the top-level await. The key is
// inlined at build time, so builds without it don't include App Check at all.
if (!useEmulators && import.meta.env.VITE_APPCHECK_SITE_KEY) {
  const { initializeAppCheck, ReCaptchaEnterpriseProvider } = await import('firebase/app-check')
  // Dev server only; vite.config.js refuses to build while the token is set.
  if (import.meta.env.DEV && import.meta.env.VITE_APPCHECK_DEBUG_TOKEN) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN
  }
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(import.meta.env.VITE_APPCHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  })
}

export const auth = getAuth(app)
// Default in-memory cache: each tab has its own connection. Simpler and without
// the multi-tab IndexedDB quirks; the extra reads cost cents (Blaze plan).
export const db = getFirestore(app)
export const googleProvider = new GoogleAuthProvider()
// hd makes Google offer only accounts of that Workspace domain. It's a hint, not a
// check: the auth store and firestore.rules reject other domains.
googleProvider.setCustomParameters({
  prompt: 'select_account',
  ...(ALLOWED_DOMAINS.length === 1 && !useEmulators ? { hd: ALLOWED_DOMAINS[0] } : {}),
})

if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
}
