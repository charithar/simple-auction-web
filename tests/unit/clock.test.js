import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRenderer, defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../src/firebase.js', () => ({ auth: {}, db: {}, googleProvider: {}, useEmulators: false }))
const { useClockStore, useNow } = await import('../../src/stores/clock.js')
const { useAuthStore } = await import('../../src/stores/auth.js')

// A renderer with no DOM, enough to mount components so onMounted/onUnmounted run.
const node = (type) => ({ type, children: [], text: '' })
const { createApp } = createRenderer({
  createElement: node,
  createText: (text) => ({ ...node('#text'), text }),
  createComment: (text) => ({ ...node('#comment'), text }),
  insert: (child, parent) => parent.children.push(child),
  remove: () => {},
  setText: (n, text) => (n.text = text),
  setElementText: (n, text) => (n.text = text),
  parentNode: () => null,
  nextSibling: () => null,
  patchProp: () => {},
})

let pinia
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  pinia = createPinia()
  setActivePinia(pinia)
})
afterEach(() => vi.useRealTimers())

describe('clock store', () => {
  it('now is the local time corrected by the server clock offset', () => {
    useAuthStore().clockOffsetMs = 2_500
    expect(useClockStore().now).toBe(1_002_500)
  })

  it('ticks every second only while someone holds it', () => {
    const clock = useClockStore()
    clock.acquire()
    clock.acquire()
    vi.advanceTimersByTime(3_000)
    expect(clock.now).toBe(1_003_000)
    clock.release()
    vi.advanceTimersByTime(1_000)
    expect(clock.now).toBe(1_004_000) // one holder left: still ticking
    clock.release()
    vi.advanceTimersByTime(5_000)
    expect(clock.now).toBe(1_004_000) // nobody left: stopped
    expect(vi.getTimerCount()).toBe(0)
  })

  it('useNow holds the ticker while its component is mounted', () => {
    let now
    const Comp = defineComponent({
      setup() {
        now = useNow()
        return () => h('span')
      },
    })
    const app = createApp(Comp).use(pinia)
    app.mount(node('root'))
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(2_000)
    expect(now.value).toBe(1_002_000)
    app.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
