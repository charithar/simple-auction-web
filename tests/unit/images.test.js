import { describe, it, expect } from 'vitest'
import { imageUrlOk } from '../../src/lib/images.js'

describe('imageUrlOk', () => {
  it.each([
    'https://example.org/a.webp', 'HTTPS://example.org/a.png', 'images/lot-0.webp', './images/a.webp', 'a.webp',
  ])('accepts %s', (u) => expect(imageUrlOk(u)).toBe(true))

  it.each([
    'http://example.org/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'blob:https://x/1',
    '//evil.example/a.png', '/images/a.webp', String.raw`\\host\a.png`, 'https:///a.png', 'images/a b.webp', 'file:///c:/a.png',
  ])('rejects %s', (u) => expect(imageUrlOk(u)).toBe(false))
})
