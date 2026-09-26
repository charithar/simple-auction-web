import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { downloadText, stamp } from '../../src/lib/download.js'

describe('downloadText', () => {
  let anchor
  let appended
  beforeEach(() => {
    vi.useFakeTimers()
    anchor = { click: vi.fn(), remove: vi.fn() }
    appended = []
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor), body: { append: (el) => appended.push(el) } })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake/1')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('saves the text as a CSV file through a temporary link', async () => {
    downloadText('winners.csv', 'a,b\r\n1,2')
    expect(document.createElement).toHaveBeenCalledWith('a')
    expect(anchor).toMatchObject({ href: 'blob:fake/1', download: 'winners.csv' })
    expect(appended).toEqual([anchor])
    expect(anchor.click).toHaveBeenCalledTimes(1)
    expect(anchor.remove).toHaveBeenCalledTimes(1)
    const blob = URL.createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('text/csv;charset=utf-8')
    expect(await blob.text()).toBe('a,b\r\n1,2')
  })

  it('frees the object URL a second later, and honours another type', () => {
    downloadText('x.json', '{}', 'application/json')
    expect(URL.createObjectURL.mock.calls[0][0].type).toBe('application/json')
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake/1')
  })
})

describe('stamp', () => {
  it('formats a local date and time for file names', () => {
    expect(stamp(new Date(2026, 9, 31, 18, 5))).toBe('2026-10-31_1805')
    expect(stamp(new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02_0304')
  })
})
