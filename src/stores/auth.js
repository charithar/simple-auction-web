import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { onAuthStateChanged, signInWithPopup, signOut as fbSignOut } from 'firebase/auth'
import { auth, db, googleProvider } from '../firebase.js'
import { syncProfile, checkAdmin } from '../lib/profile.js'

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

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null) // { uid, name, email, photoURL } once the profile doc exists
  const isAdmin = ref(false)
  const clockOffsetMs = ref(0)
  const ready = ref(false) // first auth state (incl. profile + admin check) resolved
  const busy = ref(false)
  const error = ref('')

  const signedIn = computed(() => user.value !== null)

  let resolveReady
  const readyPromise = new Promise((r) => (resolveReady = r))
  let started = false
  let generation = 0 // ignores results from a previous auth state

  function init() {
    if (started) return
    started = true
    onAuthStateChanged(auth, async (fbUser) => {
      const gen = ++generation
      if (!fbUser) {
        user.value = null
        isAdmin.value = false
        markReady()
        return
      }
      busy.value = true
      try {
        const [{ profile, clockOffsetMs: offset }, admin] = await Promise.all([
          syncProfile(db, fbUser),
          checkAdmin(db, fbUser.uid),
        ])
        if (gen !== generation) return
        user.value = { uid: fbUser.uid, name: profile.name, email: fbUser.email, photoURL: fbUser.photoURL }
        isAdmin.value = admin
        clockOffsetMs.value = offset
        error.value = ''
      } catch (e) {
        if (gen !== generation) return
        console.error('Profile sync failed', e)
        error.value = 'Your profile could not be loaded. Please sign in again.'
        user.value = null
        isAdmin.value = false
        // Keep Firebase and app state consistent so "Sign in" really retries.
        fbSignOut(auth).catch(() => {})
      } finally {
        if (gen === generation) {
          busy.value = false
          markReady()
        }
      }
    })
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

  return { user, isAdmin, clockOffsetMs, ready, busy, error, signedIn, init, whenReady, signIn, signOut }
})
