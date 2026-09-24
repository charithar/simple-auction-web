import { ref, readonly } from 'vue'

// Shared browser connectivity flag. navigator.onLine can report true on a
// captive/dead network, but false is reliable, which is what matters here.
const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine)
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => (online.value = true))
  window.addEventListener('offline', () => (online.value = false))
}

export const useOnline = () => readonly(online)
