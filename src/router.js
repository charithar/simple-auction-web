import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuthStore } from './stores/auth.js'
import HomeView from './views/HomeView.vue'

// Hash history: works on any static host without a 404.html fallback.
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('./views/AdminView.vue'),
      meta: { requiresAdmin: true },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

// Wait for the first auth state (and admin check) before deciding, so a
// direct load of #/admin isn't bounced while auth is still resolving.
router.beforeEach(async (to) => {
  if (!to.meta.requiresAdmin) return true
  const auth = useAuthStore()
  auth.init()
  await auth.whenReady()
  return auth.isAdmin ? true : { name: 'home' }
})

export default router
