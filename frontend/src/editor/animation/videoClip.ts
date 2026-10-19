/**
 * When a clip plays on the page clock.
 *
 * A clip is on screen from the moment its object's enter animation starts until its exit animation ends, and
 * inside that window it runs at its own speed: the time inside the clip is the time since it appeared, scaled
 * by the speed, trimmed to the part the user kept and (when it loops) repeated.
 */
import type { DocObject } from '@/types/document'
import { videoOf, videoSpeed, videoWindow } from '../engine/objects/video'
import { animationOf } from './model'

export interface ClipWindow {
  /** When the clip appears on the page clock, ms. */
  startMs: number
  /** When it disappears, ms; Infinity when it stays until the page ends. */
  endMs: number
}

/** The window the clip is on screen: with its enter animation and until its exit is over. */
export function clipWindow(object: DocObject): ClipWindow {
  const animation = animationOf(object)
  const exit = animation?.exit
  return {
    startMs: animation?.enter?.delayMs ?? 0,
    endMs: exit ? exit.delayMs + exit.durationMs : Number.POSITIVE_INFINITY,
  }
}

/** True when the clip is on screen at the page time `tMs`. */
export function clipVisible(object: DocObject, tMs: number): boolean {
  const { startMs, endMs } = clipWindow(object)
  return tMs >= startMs && tMs < endMs
}

/**
 * The time inside the clip at the page time `tMs`, in ms: after the trim, at the clip's own speed, repeated
 * when it loops. 0 when the object is not a clip.
 */
export function clipTimeMs(object: DocObject, tMs: number): number {
  const video = videoOf(object)
  if (!video) return 0
  const { from, to } = videoWindow(video)
  const span = to - from
  if (span <= 0) return from
  const { startMs } = clipWindow(object)
  const elapsed = Math.max(0, tMs - startMs) * videoSpeed(video)
  const within = video.loop ? elapsed % span : Math.min(elapsed, span)
  return from + within
}
