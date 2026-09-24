import { defineStore } from 'pinia'
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAuthStore } from './auth.js'

// One shared 1s ticker for every countdown, corrected to server time.
export const useClockStore = defineStore('clock', () => {
  const auth = useAuthStore()
  const tick = ref(Date.now())
  const now = computed(() => tick.value + auth.clockOffsetMs)

  let subscribers = 0
  let timer = null

  function acquire() {
    if (subscribers++ === 0) {
      tick.value = Date.now()
      timer = setInterval(() => (tick.value = Date.now()), 1000)
    }
  }

  function release() {
    if (--subscribers === 0) {
      clearInterval(timer)
      timer = null
    }
  }

  return { now, acquire, release }
})

// Use in components: const now = useNow()  -> computed server-time ms
export function useNow() {
  const clock = useClockStore()
  onMounted(clock.acquire)
  onUnmounted(clock.release)
  return computed(() => clock.now)
}
