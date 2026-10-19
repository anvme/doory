/**
 * Video clips on a page. A clip is a picture (its poster frame) with a `video` prop that says what the clip is
 * and how it plays; the frame renderer draws the clip itself, from a live element in the editor and from the
 * poster everywhere else.
 */
import type { DocObject, VideoProps } from '@/types/document'

/** The prop a clip object carries. */
export const VIDEO_PROP = 'video'

export function isVideoProps(value: unknown): value is VideoProps {
  return typeof value === 'object' && value !== null && typeof (value as VideoProps).src === 'string'
}

/** The clip of a document object, or null when it is not a clip. */
export function videoOf(object: DocObject): VideoProps | null {
  const value = object[VIDEO_PROP]
  return isVideoProps(value) ? value : null
}

/** True when the document object is a clip. */
export function isVideoObject(object: DocObject): boolean {
  return isVideoProps(object[VIDEO_PROP])
}

/** The key a clip is known by in the editor and in the export: its asset, or its file when it has none. */
export function videoKey(video: VideoProps): string {
  return video.assetId || video.src
}

/** The length of the clip as a whole, ms. */
export function videoDurationMs(video: VideoProps): number {
  return Math.max(0, video.durationMs ?? 0)
}

/** Where in the clip the play starts and stops, ms. */
export function videoWindow(video: VideoProps): { from: number; to: number } {
  const from = Math.max(0, video.trimStartMs ?? 0)
  const to = Math.max(from, video.trimEndMs ?? videoDurationMs(video))
  return { from, to }
}

/** The clip's speed: 1 unless the user slowed it down or sped it up. */
export function videoSpeed(video: VideoProps): number {
  const speed = video.speed ?? 1
  return Number.isFinite(speed) && speed > 0 ? speed : 1
}

/** The clip's loudness, 0..1. */
export function videoVolume(video: VideoProps): number {
  const volume = video.volume ?? 1
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1
}
