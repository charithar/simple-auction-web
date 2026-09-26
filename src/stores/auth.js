import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { onAuthStateChanged, signInWithPopup, signOut as fbSignOut } from 'firebase/auth'
import { auth, db, googleProvider, useEmulators } from '../firebase.js'
import { emailAllowed, allowedDomainsText } from '../lib/access.js'
import { syncProfile, checkAdmin } from '../lib/profile.js'
import { retryDelay } from '../lib/retry.js'

const signInMessages = {
  'auth/popup-blocked': 'Your browser blocked the sign-in popup. Allow popups for this site and try again.',
  'auth/unauthorized-domain': 'This site is not an authorized domain in Firebase Authentication.',
  'auth/operation-not-supported-in-this-environment':
    'Sign-in is not supported in this browser. Open the link in Chrome or Safari.',
  'auth/network-request-failed': 'Network error. Check your connection and try again.',
}

// Google blocks OAuth inside most in-app browsers (Facebook, Instagram, LINE...).
export const isInAppBrowser = () =>
  /FBAN|FBAV|Instagram|Line\/|MicroMessenger|; wv\)/i.test(navigator.userAgent)

// Last measured clock offset, for page loads that can't measure one (the profile
// was touched under a minute ago, e.g. a quick reload). Device clocks drift
// slowly, so a recent value beats assuming the clock is right.
const OFFSET_KEY = 'auction.clockOffset'
const OFFSET_MAX_AGE_MS = 12 * 3_600_000

export function storedOffset(now = Date.now()) {
  try {
    const v = JSON.parse(localStorage.getItem(OFFSET_KEY))
    return v && Number.isFinite(v.offset) && now - v.at < OFFSET_MAX_AGE_MS ? v.offset : null
  } catch {
    return null
  }
}

export function storeOffset(offset, now = Date.now()) {
  try {
    localStorage.setItem(OFFSET_KEY, JSON.stringify({ offset, at: now }))
  } catch {
    /* storage blocked: the next quick reload assumes 0 */
  }
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null) // { uid, name, email, photoURL } once the profile doc exists
  const isAdmin = ref(false)
  const clockOffsetMs = ref(0)
  const ready = ref(false) // first auth state (incl. profile + admin check) resolved
  const busy = ref(false)
  const error = ref('')
  // Signed in with Google, but the rules refuse everything (emergency stop on):
  // the profile load is retried on a schedule instead of signing the user out.
  const retrying = ref(false)

  const signedIn = computed(() => user.value !== null)

  let resolveReady
  const readyPromise = new Promise((r) => (resolveReady = r))
  let started = false
  let generation = 0 // ignores results from a previous auth state
  let retryTimer = null

  function init() {
    if (started) return
    started = true
    onAuthStateChanged(auth, async (fbUser) => {
      const gen = ++generation
      clearTimeout(retryTimer)
      retryTimer = null
      retrying.value = false
      if (!fbUser) {
        user.value = null
        isAdmin.value = false
        busy.value = false // a sign-out can arrive while a profile sync is still running
        markReady()
        return
      }
      // Other domains are refused by the rules anyway; sign them out before any
      // Firestore request and say which account to use.
      if (!emailAllowed(fbUser.email, { emulator: useEmulators })) {
        const domains = allowedDomainsText()
        error.value = domains
          ? `Please sign in with your ${domains} Google account.`
          : 'Sign-in is not set up for this site yet (no allowed domains configured).'
        user.value = null
        isAdmin.value = false
        fbSignOut(auth).catch(() => {})
        markReady()
        return
      }
      await loadProfile(fbUser, gen, 0)
    })
  }

  // Profile sync (also measures the clock offset) + admin check on every page
  // load: 2 reads and at most 1 write. Only the UI relies on the admin flag;
  // the security rules check registration/admin themselves.
  async function loadProfile(fbUser, gen, attempt) {
    busy.value = true
    try {
      const [{ profile, clockOffsetMs: offset }, admin] = await Promise.all([
        syncProfile(db, fbUser),
        checkAdmin(db, fbUser.uid),
      ])
      if (gen !== generation) return
      user.value = { uid: fbUser.uid, name: profile.name, email: fbUser.email, photoURL: fbUser.photoURL }
      isAdmin.value = admin
      // null: not measured (profile touched under a minute ago): use the last
      // measured offset, else assume the device clock is right.
      if (offset != null) storeOffset(offset)
      clockOffsetMs.value = offset ?? storedOffset() ?? 0
      error.value = ''
      retrying.value = false
    } catch (e) {
      if (gen !== generation) return
      console.error('Profile sync failed', e)
      user.value = null
      isAdmin.value = false
      if (e.code === 'permission-denied') {
        // The rules refuse this user everything: the admin's emergency stop is on.
        // Keep the Google session and try again, so the page comes back by itself.
        error.value = 'The auction is temporarily unavailable. This page reconnects by itself.'
        retrying.value = true
        // A new auth state (sign-out, another account) cancels this timer.
        retryTimer = setTimeout(() => loadProfile(fbUser, gen, attempt + 1), retryDelay(attempt))
      } else {
        error.value = 'Your profile could not be loaded. Please sign in again.'
        // Keep Firebase and app state consistent so "Sign in" really retries.
        fbSignOut(auth).catch(() => {})
      }
    } finally {
      if (gen === generation) {
        busy.value = false
        markReady()
      }
    }
  }

  function markReady() {
    ready.value = true
    resolveReady()
  }

  const whenReady = () => readyPromise

  async function signIn() {
    error.value = ''
    try {
      await signInWithPopup(auth, googleProvider)
    } catch (e) {
      if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return
      console.error('Sign-in failed', e)
      error.value = signInMessages[e.code]
        ?? (isInAppBrowser()
          ? 'Sign-in does not work inside this app. Open the link in Chrome or Safari.'
          : 'Sign-in failed. Please try again.')
    }
  }

  const signOut = () => fbSignOut(auth)

  return { user, isAdmin, clockOffsetMs, ready, busy, error, retrying, signedIn, init, whenReady, signIn, signOut }
})
