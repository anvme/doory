import { describe, expect, it } from 'vitest'
import type { DocObject, VideoProps } from '@/types/document'
import { clipTimeMs, clipVisible, clipWindow } from './videoClip'

const video = (over: Partial<VideoProps> = {}): VideoProps => ({
  src: '/media/video/clip.mp4',
  poster: '/media/video/clip.webp',
  durationMs: 10_000,
  trimStartMs: 0,
  trimEndMs: 10_000,
  ...over,
})

const object = (over: Partial<VideoProps> = {}, animation?: DocObject['animation']): DocObject => ({
  id: 'clip1',
  type: 'image',
  video: video(over),
  ...(animation ? { animation } : {}),
})

describe('clipWindow', () => {
  it('starts with the object and stays until the page ends', () => {
    expect(clipWindow(object())).toEqual({ startMs: 0, endMs: Number.POSITIVE_INFINITY })
  })

  it('follows the enter and the exit of the object', () => {
    const o = object({}, { enter: { preset: 'fade', durationMs: 500, delayMs: 200, easing: 'ease-out' }, exit: { preset: 'fade', durationMs: 300, delayMs: 4000, easing: 'ease-out' } })
    expect(clipWindow(o)).toEqual({ startMs: 200, endMs: 4300 })
  })
})

describe('clipTimeMs', () => {
  it('counts from the start of the clip', () => {
    expect(clipTimeMs(object(), 0)).toBe(0)
    expect(clipTimeMs(object(), 2500)).toBe(2500)
  })

  it('starts when the object comes in', () => {
    const o = object({}, { enter: { preset: 'fade', durationMs: 500, delayMs: 1000, easing: 'ease-out' } })
    expect(clipTimeMs(o, 500)).toBe(0)
    expect(clipTimeMs(o, 1500)).toBe(500)
  })

  it('keeps to the trimmed part', () => {
    const o = object({ trimStartMs: 2000, trimEndMs: 5000 })
    expect(clipTimeMs(o, 0)).toBe(2000)
    expect(clipTimeMs(o, 1000)).toBe(3000)
    expect(clipTimeMs(o, 10_000)).toBe(5000)
  })

  it('repeats when the clip loops', () => {
    const o = object({ trimStartMs: 0, trimEndMs: 1000, loop: true })
    expect(clipTimeMs(o, 1500)).toBe(500)
    expect(clipTimeMs(o, 2000)).toBe(0)
  })

  it('runs at the speed the clip asks for', () => {
    const o = object({ speed: 2 })
    expect(clipTimeMs(o, 1000)).toBe(2000)
  })

  it('is zero for an object that is not a clip', () => {
    expect(clipTimeMs({ id: 'a', type: 'rect' }, 1000)).toBe(0)
  })
})

describe('clipVisible', () => {
  it('is on screen from the enter to the end of the exit', () => {
    const o = object({}, { enter: { preset: 'fade', durationMs: 500, delayMs: 1000, easing: 'ease-out' }, exit: { preset: 'fade', durationMs: 300, delayMs: 4000, easing: 'ease-out' } })
    expect(clipVisible(o, 999)).toBe(false)
    expect(clipVisible(o, 1000)).toBe(true)
    expect(clipVisible(o, 4300)).toBe(false)
  })
})
