import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { parseDomains } from './src/lib/access.js'

// A build without these deploys a site where sign-in fails (e.g. no authDomain:
// auth/auth-domain-config-required), so `vite build` refuses to run without them.
const REQUIRED = [
  'VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID',
  'VITE_ALLOWED_DOMAINS',
]

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env }
  // parseDomains throws on a malformed VITE_ALLOWED_DOMAINS, failing the build
  // instead of shipping a page that crashes on load.
  parseDomains(env.VITE_ALLOWED_DOMAINS)
  // The App Check debug token bypasses App Check for whoever holds it; it must never
  // reach a bundle. Set it only while using `npm run dev`.
  if (command === 'build' && String(env.VITE_APPCHECK_DEBUG_TOKEN ?? '').trim()) {
    throw new Error('VITE_APPCHECK_DEBUG_TOKEN is set: remove it from .env.local (and the environment) before building.')
  }
  if (command === 'build' && env.VITE_USE_EMULATORS !== 'true') {
    const missing = REQUIRED.filter((k) => !String(env[k] ?? '').trim())
    if (missing.length) {
      throw new Error(`Missing ${missing.join(', ')}: set them in .env.local.`)
    }
  }

  return {
    // Relative base + hash routing lets the build be served from any path
    // (Cloudflare Pages, a sub-folder, a file server) without a 404 fallback.
    base: './',
    plugins: [vue(), tailwindcss()],
    // Firebase Auth + Firestore alone is ~600 kB minified (~195 kB gzip); that's expected.
    build: { chunkSizeWarningLimit: 800 },
    test: {
      include: ['tests/**/*.test.js'],
      environment: 'node',
      testTimeout: 20000,
      fileParallelism: false,
      // npm run test:coverage (unit + rules suites together). Components (.vue)
      // need a browser; the e2e scripts in scripts/browser/ cover them.
      coverage: {
        provider: 'v8',
        include: ['src/**/*.js'],
        reporter: ['text', 'html', 'json-summary'],
        reportsDirectory: 'coverage',
      },
    },
  }
})
