import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// main.js: mounts the app, and reloads once when a lazily loaded chunk is gone
// after a redeploy (vite:preloadError), without reloading in a loop.
const app = { use: vi.fn(() => app), mount: vi.fn(() => app) }
vi.mock('vue', async (importOriginal) => ({ ...(await importOriginal()), createApp: vi.fn(() => app) }))
vi.mock('../../src/App.vue', () => ({ default: { name: 'App' } }))
vi.mock('../../src/router.js', () => ({ default: { name: 'router' } }))
vi.mock('../../src/style.css', () => ({}))

let handler
let storage
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  storage = new Map()
  vi.stubGlobal('window', {
    addEventListener: (type, fn) => type === 'vite:preloadError' && (handler = fn),
    location: { reload: vi.fn() },
  })
  vi.stubGlobal('sessionStorage', { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) })
  await import('../../src/main.js')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const preloadError = () => {
  const event = { preventDefault: vi.fn() }
  handler(event)
  return event
}

describe('main.js', () => {
  it('mounts the app with Pinia and the router on #app', async () => {
    const { createApp } = await import('vue')
    expect(createApp).toHaveBeenCalledWith({ name: 'App' })
    expect(app.use).toHaveBeenCalledWith({ name: 'router' })
    expect(app.mount).toHaveBeenCalledWith('#app')
  })

  it('a missing chunk after a redeploy reloads the page once', () => {
    const event = preloadError()
    expect(event.preventDefault).toHaveBeenCalled()
    expect(window.location.reload).toHaveBeenCalledTimes(1)
    expect(storage.get('auction.chunkReload')).toBe('1000000')
  })

  it('a second failure within 10 s lets the error surface instead of looping', () => {
    preloadError()
    vi.advanceTimersByTime(9_000)
    const event = preloadError()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.location.reload).toHaveBeenCalledTimes(1)
  })

  it('a failure long after the last reload reloads again', () => {
    preloadError()
    vi.advanceTimersByTime(11_000)
    preloadError()
    expect(window.location.reload).toHaveBeenCalledTimes(2)
  })

  it('without session storage it cannot guard against a loop, so it does not reload', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => {} })
    const event = preloadError()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.location.reload).not.toHaveBeenCalled()
  })
})
