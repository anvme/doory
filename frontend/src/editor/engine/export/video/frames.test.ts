import { describe, expect, it } from 'vitest'
import { CAPTURE_MAX_BYTES, ClipFrameCache } from './frames'

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas')
  element.width = width
  element.height = height
  return element
}

describe('ClipFrameCache', () => {
  it('keeps a frame and gives it back', () => {
    const cache = new ClipFrameCache()
    const frame = canvas(4, 4)
    cache.set('clip-1', 1500, frame)
    expect(cache.get('clip-1', 1500)).toBe(frame)
    expect(cache.get('clip-1', 1501)).toBeNull()
    expect(cache.get('clip-2', 1500)).toBeNull()
  })

  it('rounds the time to the millisecond', () => {
    const cache = new ClipFrameCache()
    const frame = canvas(2, 2)
    cache.set('clip-1', 1500.4, frame)
    expect(cache.get('clip-1', 1500)).toBe(frame)
  })

  it('refuses a design whose clips do not fit in the budget', () => {
    const cache = new ClipFrameCache()
    const big = canvas(2000, 2000)
    let refused = false
    try {
      for (let i = 0; i < 40; i++) cache.set('clip-1', i * 1000, big)
    } catch {
      refused = true
    }
    expect(refused).toBe(true)
    expect(CAPTURE_MAX_BYTES).toBeGreaterThan(0)
  })

  it('gives the frame renderer a source per clip', () => {
    const cache = new ClipFrameCache()
    const frame = canvas(2, 2)
    cache.set('clip-1', 0, frame)
    const sources = cache.sources()
    expect(sources.get('clip-1')?.frame(0)).toBe(frame)
    expect(sources.get('clip-1')?.frame(500)).toBeNull()
  })
})
