import { describe, it, expect, vi, beforeEach } from 'vitest'

// The router's admin guard, with memory history (no browser) and the views and
// auth store replaced.
vi.mock('vue-router', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, createWebHashHistory: () => mod.createMemoryHistory() }
})
vi.mock('../../src/views/HomeView.vue', () => ({ default: { name: 'HomeView', render: () => null } }))
vi.mock('../../src/views/AdminView.vue', () => ({ default: { name: 'AdminView', render: () => null } }))
const auth = { isAdmin: false, init: vi.fn(), whenReady: vi.fn() }
vi.mock('../../src/stores/auth.js', () => ({ useAuthStore: () => auth }))

const { default: router } = await import('../../src/router.js')

beforeEach(async () => {
  auth.isAdmin = false
  auth.init.mockClear()
  auth.whenReady.mockReset().mockResolvedValue()
  await router.push('/')
})

describe('router', () => {
  it('the home page needs no auth check', async () => {
    await router.push('/?item=item-007')
    expect(router.currentRoute.value).toMatchObject({ name: 'home', query: { item: 'item-007' } })
    expect(auth.init).not.toHaveBeenCalled()
  })

  it('non-admins are sent from #/admin to the home page', async () => {
    await router.push('/admin')
    expect(router.currentRoute.value.name).toBe('home')
    expect(auth.init).toHaveBeenCalled()
  })

  it('admins get the admin page', async () => {
    auth.isAdmin = true
    await router.push('/admin')
    expect(router.currentRoute.value.name).toBe('admin')
  })

  it('the guard waits for the first auth state before deciding (a direct load of #/admin)', async () => {
    let resolve
    auth.whenReady.mockReturnValue(new Promise((r) => (resolve = r)))
    const navigation = router.push('/admin')
    await new Promise((r) => setTimeout(r, 10))
    expect(router.currentRoute.value.name).toBe('home') // still deciding
    auth.isAdmin = true // e.g. the admin check finished
    resolve()
    await navigation
    expect(router.currentRoute.value.name).toBe('admin')
  })

  it('unknown paths go to the home page', async () => {
    await router.push('/nope/deeper')
    expect(router.currentRoute.value.fullPath).toBe('/')
  })
})
