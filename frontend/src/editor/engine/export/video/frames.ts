/**
 * The frames of the clips of an export, captured before the export starts.
 *
 * A clip is played in a hidden element and the frames the export needs are copied into bitmaps, so the
 * export loop stays synchronous and two runs draw the same pictures. The cache has a byte budget: a design
 * with many or long clips is refused with a clear error instead of taking the browser's memory.
 */
import { clipTimeMs } from '../../../animation/videoClip'
import { type VideoFrameSource, type VideoFrameSources } from '../../../animation/videoFrames'
import { type DocObject, type DocPage } from '@/types/document'
import { FrameCursor } from './schedule'
import type { Prepared } from './types'
import type { Timeline } from './timeline'
import { videoKey, videoOf } from '../../objects/video'
import { VideoExportError } from './errors'

/** The budget for the captured frames, in bytes. */
export const CAPTURE_MAX_BYTES = 256 * 1024 * 1024
/** The longest side of a captured frame, px. */
const CAPTURE_MAX_EDGE = 1280

/** One clip the export needs pictures of. */
export interface ClipCapture {
  /** The clip's key (its asset, or its file). */
  key: string
  /** The clip's file (the logical URL; it is resolved before the capture). */
  src: string
  /** The times inside the clip the export needs, ms. */
  times: number[]
}

/** The captured frames, by the clip and the time inside it. */
export class ClipFrameCache {
  private readonly captured = new Map<string, Map<number, HTMLCanvasElement>>()
  private bytes = 0

  /** The frame of the clip at `tMs`, or null when it was not captured. */
  get(key: string, tMs: number): HTMLCanvasElement | null {
    const times = this.captured.get(key)
    if (!times) return null
    return times.get(Math.round(tMs)) ?? null
  }

  /** Keeps a frame; the budget is checked before it is kept. */
  set(key: string, tMs: number, canvas: HTMLCanvasElement): void {
    const size = canvas.width * canvas.height * 4
    if (this.bytes + size > CAPTURE_MAX_BYTES) {
      throw new VideoExportError('memory', 'The videos of this design are too long to export.')
    }
    this.bytes += size
    const times = this.captured.get(key) ?? new Map<number, HTMLCanvasElement>()
    times.set(Math.round(tMs), canvas)
    this.captured.set(key, times)
  }

  /** The frame sources the frame renderer reads. */
  sources(): VideoFrameSources {
    const sources = new Map<string, VideoFrameSource>()
    for (const key of this.captured.keys()) {
      sources.set(key, { frame: (tMs: number) => this.get(key, tMs) })
    }
    return sources
  }

  dispose(): void {
    for (const times of this.captured.values()) {
      for (const canvas of times.values()) {
        canvas.width = 1
        canvas.height = 1
      }
    }
    this.captured.clear()
    this.bytes = 0
  }
}

/** The clips of a page, with the times inside the clip that the export needs. */
export function clipsOfPage(page: DocPage, pageTimes: readonly number[]): { object: DocObject; key: string; src: string; times: number[] }[] {
  const clips: { object: DocObject; key: string; src: string; times: number[] }[] = []
  for (const object of page.objects) {
    const video = videoOf(object)
    if (!video) continue
    const times = pageTimes.map((tMs) => Math.round(clipTimeMs(object, tMs)))
    clips.push({ object, key: videoKey(video), src: video.src, times: [...new Set(times)] })
  }
  return clips
}

/** The clips of the exported pages, with the times inside the clip that the frames ask for. */
export function clipsOfExport(timeline: Timeline, frames: number, fps: number): ClipCapture[] {
  const cursor = new FrameCursor(timeline, fps)
  const byKey = new Map<string, ClipCapture>()
  for (let i = 0; i < frames; i++) {
    const plan = cursor.at(i)
    if (plan.kind !== 'page') continue
    for (const clip of clipsOfPage(plan.segment.page, [plan.pageMs])) {
      const known = byKey.get(clip.key)
      if (known) known.times.push(...clip.times.filter((time) => !known.times.includes(time)))
      else byKey.set(clip.key, { key: clip.key, src: clip.src, times: [...clip.times] })
    }
  }
  return [...byKey.values()]
}

/** Captures the frames of the clips of the export into `cache`. */
export async function captureExportClips(
  prepared: Prepared,
  cache: ClipFrameCache,
  fps: number,
  resolveSrc: (src: string) => Promise<string>,
): Promise<void> {
  for (const clip of clipsOfExport(prepared.timeline, prepared.frames, fps)) {
    const src = await resolveSrc(clip.src)
    await captureClips([{ ...clip, src }], cache, async (s) => s)
  }
}

function once(target: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      cleanup()
      resolve()
    }
    const failed = (): void => {
      cleanup()
      reject(new VideoExportError('render', 'A video of the design could not be read.'))
    }
    const cleanup = (): void => {
      target.removeEventListener(event, done)
      target.removeEventListener('error', failed)
    }
    target.addEventListener(event, done, { once: true })
    target.addEventListener('error', failed, { once: true })
  })
}

/** Waits until the element shows the picture at `timeSec`. */
function seek(video: HTMLVideoElement, timeSec: number): Promise<void> {
  if (Math.abs(video.currentTime - timeSec) < 0.001 && video.readyState >= 2) return Promise.resolve()
  const seeked = once(video, 'seeked')
  video.currentTime = timeSec
  return seeked
}

/**
 * Captures the frames of the clips the export needs. The frames are copied into canvases, so the export
 * loop can draw them without touching the video elements again.
 */
export async function captureClips(
  clips: readonly ClipCapture[],
  cache: ClipFrameCache,
  resolveSrc: (src: string) => Promise<string>,
): Promise<void> {
  for (const clip of clips) {
    if (clip.times.length === 0) continue
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    video.src = await resolveSrc(clip.src)
    await once(video, 'loadeddata')
    const width = Math.min(CAPTURE_MAX_EDGE, video.videoWidth || CAPTURE_MAX_EDGE)
    const height = Math.round((width * (video.videoHeight || 0)) / (video.videoWidth || width)) || 1
    for (const timeMs of clip.times) {
      await seek(video, timeMs / 1000)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new VideoExportError('render', 'This browser cannot draw on a canvas.')
      ctx.drawImage(video, 0, 0, width, height)
      cache.set(clip.key, timeMs, canvas)
    }
    video.removeAttribute('src')
    video.load()
  }
}
