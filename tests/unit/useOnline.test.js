import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isReadonly } from 'vue'

// useOnline reads the browser's state when the module loads, so each test
// stubs the globals first and imports a fresh copy.
function fakeWindow() {
  const handlers = {}
  return { handlers, addEventListener: (type, fn) => (handlers[type] = fn) }
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('useOnline', () => {
  it('starts from navigator.onLine and follows the online/offline events', async () => {
    const win = fakeWindow()
    vi.stubGlobal('navigator', { onLine: false })
    vi.stubGlobal('window', win)
    const { useOnline } = await import('../../src/composables/useOnline.js')
    const online = useOnline()
    expect(online.value).toBe(false)
    win.handlers.online()
    expect(online.value).toBe(true)
    win.handlers.offline()
    expect(online.value).toBe(false)
  })

  it('is read-only for its users', async () => {
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('window', fakeWindow())
    const { useOnline } = await import('../../src/composables/useOnline.js')
    expect(isReadonly(useOnline())).toBe(true)
  })

  it('assumes online outside a browser (no navigator, no window)', async () => {
    vi.stubGlobal('navigator', undefined)
    vi.stubGlobal('window', undefined)
    const { useOnline } = await import('../../src/composables/useOnline.js')
    expect(useOnline().value).toBe(true)
  })
})
