import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { parseDomains } from './src/lib/access.js'

// Relative base + hash routing lets the build be served from any path
// (e.g. https://<user>.github.io/<repo>/) without a 404 fallback.
export default defineConfig(({ mode }) => {
  // parseDomains throws on a malformed VITE_ALLOWED_DOMAINS, failing the build
  // instead of shipping a page that crashes on load.
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env }
  const domains = parseDomains(env.VITE_ALLOWED_DOMAINS)
  if (mode === 'production' && env.VITE_USE_EMULATORS !== 'true' && !domains.length) {
    console.warn('\nVITE_ALLOWED_DOMAINS is empty: nobody will be able to sign in to this build.\n')
  }

  return {
    base: './',
    plugins: [vue(), tailwindcss()],
    // Firebase Auth + Firestore alone is ~600 kB minified (~195 kB gzip); that's expected.
    build: { chunkSizeWarningLimit: 800 },
    test: {
      include: ['tests/**/*.test.js'],
      environment: 'node',
      testTimeout: 20000,
      fileParallelism: false,
    },
  }
})
