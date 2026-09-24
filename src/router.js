import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'

// Hash history: works on GitHub Pages without a 404.html fallback.
export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    // /admin (with an auth-resolved guard) arrives in milestone 5.
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
