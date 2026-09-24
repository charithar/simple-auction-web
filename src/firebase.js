import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider, connectAuthEmulator } from 'firebase/auth'
import {
  initializeFirestore, connectFirestoreEmulator, persistentLocalCache, persistentMultipleTabManager,
} from 'firebase/firestore'

const env = import.meta.env
const useEmulators = env.VITE_USE_EMULATORS === 'true'

const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY || 'demo-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: useEmulators ? 'demo-auction' : env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
})

// Optional App Check (reCAPTCHA v3): lets Firestore reject requests that don't come
// from this site, so scripts can't burn the free read quota. Only active when a site
// key is configured; enforcement itself is switched on in the Firebase console.
// Must run before any Firestore/Auth request, hence the top-level await. The key is
// inlined at build time, so builds without it don't include App Check at all.
if (!useEmulators && env.VITE_APPCHECK_SITE_KEY) {
  const { initializeAppCheck, ReCaptchaV3Provider } = await import('firebase/app-check')
  if (env.DEV && env.VITE_APPCHECK_DEBUG_TOKEN) self.FIREBASE_APPCHECK_DEBUG_TOKEN = env.VITE_APPCHECK_DEBUG_TOKEN
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(env.VITE_APPCHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  })
}

export const auth = getAuth(app)
// Persistent cache: when a listener re-attaches within 30 minutes (page reload,
// tab woken up), Firestore resumes from the cached state and bills only the
// documents that changed instead of all items. Key to staying in the free quota.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
})
export const googleProvider = new GoogleAuthProvider()
googleProvider.setCustomParameters({ prompt: 'select_account' })

if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
}
