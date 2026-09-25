import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router.js'
import './style.css'

// After a redeploy, a tab opened earlier still runs the old bundle, and its lazy
// chunks (e.g. AdminView-<oldhash>.js) no longer exist: Pages answers with
// index.html and the import fails. Reload once to pick up the new build; the
// timestamp stops a reload loop if the chunk is missing for another reason.
const RELOAD_KEY = 'auction.chunkReload'
window.addEventListener('vite:preloadError', (event) => {
  try {
    if (Date.now() - Number(sessionStorage.getItem(RELOAD_KEY) ?? 0) < 10_000) return
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    return // no storage: can't guard against a loop, so let the error surface
  }
  event.preventDefault()
  window.location.reload()
})

createApp(App).use(createPinia()).use(router).mount('#app')
