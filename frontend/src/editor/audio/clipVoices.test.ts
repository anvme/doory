import { describe, expect, it } from 'vitest'
import type { DocObject, DoryDocument, VideoProps } from '@/types/document'
import { clipTrack, clipVoices } from './clipVoices'

const video = (over: Partial<VideoProps> = {}): VideoProps => ({
  src: '/media/video/clip.mp4',
  poster: '/media/video/clip.webp',
  audioAssetId: 'a-1',
  audioUrl: '/media/audio/a-1.m4a',
  durationMs: 8000,
  trimStartMs: 0,
  trimEndMs: 8000,
  ...over,
})

const clip = (id: string, over: Partial<VideoProps> = {}, animation?: DocObject['animation']): DocObject => ({
  id,
  type: 'image',
  name: 'Holiday',
  video: video(over),
  ...(animation ? { animation } : {}),
})

const document = (objects: DocObject[]): DoryDocument => ({
  schemaVersion: 1,
  width: 100,
  height: 100,
  unit: 'px',
  pages: [{ id: 'p1', background: { type: 'solid', color: '#fff' }, objects }],
})

describe('clipTrack', () => {
  it('is the sound of the clip, from the moment the clip appears', () => {
    const track = clipTrack(clip('c1', {}, { enter: { preset: 'fade', durationMs: 500, delayMs: 1000, easing: 'ease-out' } }), 'p1')
    expect(track).toMatchObject({
      id: 'clip:c1',
      kind: 'upload',
      src: '/media/audio/a-1.m4a',
      assetId: 'a-1',
      scope: { type: 'page', pageId: 'p1' },
      startMs: 1000,
      durationMs: 8000,
      volume: 1,
    })
  })

  it('keeps to the trimmed part', () => {
    const track = clipTrack(clip('c1', { trimStartMs: 1000, trimEndMs: 4000 }), 'p1')
    expect(track?.trimStartMs).toBe(1000)
    expect(track?.trimEndMs).toBe(4000)
    expect(track?.durationMs).toBe(3000)
  })

  it('is nothing when the clip has no sound', () => {
    expect(clipTrack(clip('c1', { audioAssetId: null, audioUrl: null }), 'p1')).toBeNull()
  })

  it('takes the loudness of the clip', () => {
    expect(clipTrack(clip('c1', { volume: 0.25 }), 'p1')?.volume).toBe(0.25)
  })
})

describe('clipVoices', () => {
  it('collects the sound of every clip', () => {
    const voices = clipVoices(document([clip('c1'), clip('c2'), { id: 'r', type: 'rect' }]))
    expect(voices.map((v) => v.id)).toEqual(['clip:c1', 'clip:c2'])
  })

  it('is nothing for a page without clips', () => {
    expect(clipVoices(document([{ id: 'r', type: 'rect' }]))).toEqual([])
  })
})
