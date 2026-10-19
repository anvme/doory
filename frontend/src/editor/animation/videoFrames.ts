/**
 * Where a clip's picture comes from while a page is drawn.
 *
 * In the editor a hidden `<video>` plays the clip and the frame renderer draws its current frame; everywhere
 * else (page thumbnails, print, shared views) the poster is drawn instead; the export reads the frames it
 * captured before the export started. A source is asked for the picture of the clip at a time inside the clip,
 * so the frame renderer stays synchronous.
 */
/** The picture a clip is drawn from: a live element, a poster image or a captured frame. */
export type ClipFrame = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement

export interface VideoFrameSource {
  /** The picture of the clip at `tMs` (the time inside the clip), or null when there is none yet. */
  frame(tMs: number): ClipFrame | null
}

/** The sources of a page's clips, by the clip's key (its asset, or its file). */
export type VideoFrameSources = ReadonlyMap<string, VideoFrameSource>

/** One clip the editor plays while the page is previewed. */
export interface ClipTarget {
  /** The clip's key (its asset, or its file). */
  key: string
  /** The clip's file. */
  src: string
  /** The time inside the clip, ms. */
  timeMs: number
  /** Whether the page clock runs. */
  playing: boolean
  /** How fast the clip runs: the page's speed times the clip's own. */
  rate: number
  muted: boolean
  volume: number
}

/** How far the element may drift from the clock before it is seeked back, in seconds. */
const DRIFT_SECONDS = 0.25

/**
 * The hidden elements that play the clips of a page while the editor previews it. One element per clip, kept
 * in step with the page clock: it plays when the clock runs and is seeked back when it drifts.
 */
export class ClipPlayer {
  private readonly videos = new Map<string, HTMLVideoElement>()

  constructor(private readonly host: HTMLElement) {}

  /** The element that plays a clip; it is created the first time the clip is asked for. */
  private element(key: string, src: string): HTMLVideoElement {
    const existing = this.videos.get(key)
    if (existing) return existing
    const video = document.createElement('video')
    video.src = src
    video.preload = 'auto'
    video.playsInline = true
    video.crossOrigin = 'anonymous'
    video.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px'
    this.host.appendChild(video)
    this.videos.set(key, video)
    return video
  }

  /** The frame source of a clip: the element that plays it. */
  source(key: string, src: string): VideoFrameSource {
    const video = this.element(key, src)
    return { frame: () => (video.readyState >= 2 ? video : null) }
  }

  /** Puts every clip at its place on the page clock. */
  sync(clips: readonly ClipTarget[]): void {
    const alive = new Set<string>()
    for (const clip of clips) {
      alive.add(clip.key)
      const video = this.element(clip.key, clip.src)
      video.playbackRate = Math.min(4, Math.max(0.0625, clip.rate))
      video.muted = clip.muted
      video.volume = Math.min(1, Math.max(0, clip.volume))
      const wanted = clip.timeMs / 1000
      if (Number.isFinite(wanted) && Math.abs(video.currentTime - wanted) > DRIFT_SECONDS) {
        try {
          video.currentTime = wanted
        } catch {
          // The file is not ready yet; it will be seeked on the next tick.
        }
      }
      if (clip.playing) {
        const started = video.play() as Promise<void> | undefined
        if (started) void started.catch(() => undefined)
      } else video.pause()
    }
    for (const [key, video] of [...this.videos]) {
      if (alive.has(key)) continue
      video.pause()
      video.removeAttribute('src')
      video.load()
      video.remove()
      this.videos.delete(key)
    }
  }

  dispose(): void {
    for (const video of this.videos.values()) {
      video.pause()
      video.removeAttribute('src')
      video.load()
      video.remove()
    }
    this.videos.clear()
  }
}
