import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// Relative base + hash routing lets the build be served from any path
// (e.g. https://<user>.github.io/<repo>/) without a 404 fallback.
export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    testTimeout: 20000,
    fileParallelism: false,
  },
})
