/**
 * Design document format, schema v1.
 * Storage is always in CSS pixels @96dpi; `unit` only affects how sizes are displayed.
 */
export const SCHEMA_VERSION = 1 as const
export const MAX_PAGES = 100
export const MAX_DIMENSION_PX = 20_000

export type DocUnit = 'px' | 'mm' | 'in'

export interface GradientStop {
  offset: number
  color: string
}

export type PageBackground =
  | { type: 'solid'; color: string }
  | { type: 'gradient'; kind: 'linear' | 'radial'; angle?: number; stops: GradientStop[] }
  | {
      type: 'image'
      src: string
      fit: 'cover' | 'contain' | 'tile'
      opacity?: number
      offsetX?: number
      offsetY?: number
      scale?: number
    }

/** Output of Fabric `toObject(EXTRA_PROPS)` plus Doory props. Unknown keys round-trip untouched. */
export interface DocObject {
  id: string
  type: string
  name?: string
  locked?: boolean
  visible?: boolean
  [prop: string]: unknown
}

/** A ruler guide the user dragged out of a ruler. `pos` is in page px along the perpendicular axis. */
export interface PageGuide {
  orientation: 'horizontal' | 'vertical'
  pos: number
}

export interface DocPage {
  id: string
  name?: string
  width?: number
  height?: number
  background: PageBackground
  objects: DocObject[]
  notes?: string
  durationSec?: number
  guides?: PageGuide[]
  /** How the page comes in when a presentation or a video reaches it (see `editor/animation`). */
  transition?: PageTransition
}

export interface DocMeta {
  presetId?: string
  bleedPx?: number
  brandKitId?: string
}

export interface DoryDocument {
  schemaVersion: typeof SCHEMA_VERSION
  width: number
  height: number
  unit: DocUnit
  pages: DocPage[]
  /** Music, voiceovers and sound effects of the design (see `editor/audio`). Absent: no sound. */
  audioTracks?: AudioTrack[]
  meta?: DocMeta
}

/* ------------------------------------------------------------------------------------------------
 * Typed views of the Doory-specific object props (see
 * editor/engine/serialization.ts). They are all optional extras on top of `DocObject`.
 * ---------------------------------------------------------------------------------------------- */

export interface ShadowSpec {
  color: string
  blur: number
  offsetX: number
  offsetY: number
}

/** Object effects. Text supports every key; shapes and images support `shadow`. */
export interface ObjectEffects {
  shadow?: ShadowSpec
  outline?: { color: string; width: number }
  glow?: { color: string; blur: number }
  /** Highlight behind the glyphs. */
  background?: { color: string }
}

export type MaskShapeId =
  | 'circle'
  | 'rounded'
  | 'triangle'
  | 'diamond'
  | 'hexagon'
  | 'star'
  | 'heart'
  | 'blob'
  | 'arch'
  | 'cross'

/** Crop/mask frame of an image (or placeholder). A `{ path }` uses a 100x100 viewBox. */
export type MaskShape = MaskShapeId | { path: string }

export type ImageFilterType =
  | 'brightness'
  | 'contrast'
  | 'saturation'
  | 'hue'
  | 'blur'
  | 'vignette'
  | 'grayscale'
  | 'sepia'

export interface ImageFilterSpec {
  type: ImageFilterType
  /** Normalised amount; the meaning is per filter (see engine/objects/filters.ts). */
  value: number
}

export type ArrowHead = 'none' | 'triangle' | 'open' | 'circle' | 'diamond'

export type ListStyle = 'none' | 'bullet' | 'number'
export type TextCase = 'none' | 'upper' | 'lower' | 'title' | 'sentence'

/**
 * The frame a placeholder photo fills (`slot` on an image): the frame stays where it is while the picture moves
 * inside it. Lengths are page px, `angle` is degrees; `mask` is the crop shape (a rectangle when absent) and
 * `radius` the corner radius of a `rounded` mask. `src` remembers the sample picture the placeholder had.
 */
export interface SlotSpec {
  cx: number
  cy: number
  width: number
  height: number
  angle: number
  mask?: MaskShape
  radius?: number
  src?: string
}

/** What a template field holds: replaceable text, a picture, or a colour (the object's fill). */
export type FieldType = 'text' | 'image' | 'color'

/**
 * A template field tag (`field` on an object): a stable name for data to fill. `key` matches `FIELD_KEY`
 * (engine/fields.ts) and is unique per design, except that the same key on several pages means the same value.
 */
export interface DocField {
  key: string
  type: FieldType
  label?: string
}

/**
 * Shrink-to-fit setting on a text box (`fit` on a text object): the box height stays fixed while the font size steps
 * down from the user's `fontSize` until the wrapped lines fit or reach `minFontSize` (default `round(fontSize * 0.5)`).
 * The derived size is stored in `fitFontSize`.
 */
export interface DocTextFit {
  mode: 'shrink'
  minFontSize?: number
}

/* ------------------------------------------------------------------------------------------------
 * Animation. Optional everywhere: a document without any of it means
 * exactly what it always did. Preset ids are open strings; an id the editor does not know plays as "none".
 * ---------------------------------------------------------------------------------------------- */

export type AnimEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'spring' | 'bounce'

/** `left`/`right`/`up`/`down`: the side the object comes in from (or leaves towards); `in`/`out`: zoom in or out. */
export type AnimDirection = 'left' | 'right' | 'up' | 'down' | 'in' | 'out'

/** What a text animation steps through: the whole object, its lines, its words or its letters. */
export type AnimTextUnit = 'object' | 'line' | 'word' | 'letter'

export interface Anim {
  preset: string
  /** 100..10000 ms. */
  durationMs: number
  /** 0..60000 ms from the start of the page (the moment the page has come in). */
  delayMs: number
  easing: AnimEasing
  direction?: AnimDirection
  /** Text objects only. */
  by?: AnimTextUnit
  /** Emphasis only: repeat for as long as the page is up. */
  loop?: boolean
  /** 0..1, how strong the motion is (0.5 = the preset's own size). */
  intensity?: number
}

/** The `animation` property of an object: when it comes in, what it does while it is up, how it leaves. */
export interface ObjectAnimation {
  enter?: Anim
  exit?: Anim
  emphasis?: Anim
}

/** The `transition` property of a page: how the page comes in. */
export interface PageTransition {
  preset: string
  /** 200..3000 ms. */
  durationMs: number
  direction?: AnimDirection
  easing: AnimEasing
}

/* ------------------------------------------------------------------------------------------------
 * Video. A clip on a page is a picture (its poster frame) with these props; the clip itself is drawn by the
 * frame renderer, from a live element in the editor and from the poster everywhere else.
 * ---------------------------------------------------------------------------------------------- */

export interface VideoProps {
  /** The clip's file (the logical URL; the live object holds the resolved one). */
  src: string
  /** The poster frame: the picture the canvas shows. */
  poster: string
  /** The server asset of the clip. */
  assetId?: string
  /** The length of the whole clip, ms. */
  durationMs?: number
  /** Where in the clip the play starts and stops, ms. */
  trimStartMs?: number
  trimEndMs?: number
  /** Whether the clip repeats while it is on the page. */
  loop?: boolean
  /** Whether the clip's sound is off. */
  muted?: boolean
  /** 0..1, the clip's loudness. */
  volume?: number
  /** 1 is the normal speed. */
  speed?: number
  /** The asset that holds the clip's sound, when it has one. */
  audioAssetId?: string | null
  /** Where the clip's sound can be fetched. */
  audioUrl?: string | null
  /** The logical clip URL, kept while the live object holds the resolved one. */
  docSrc?: string
}

/* ------------------------------------------------------------------------------------------------
 * Audio. One optional document-level list; a document without it means exactly
 * what it always did. `editor/audio/model.ts` holds the limits and the tolerant reader.
 * ---------------------------------------------------------------------------------------------- */

export type AudioTrackKind = 'music' | 'voiceover' | 'sfx' | 'upload'

/** What a track is counted from: the start of the design, or the start of one page. */
export type AudioScope = { type: 'design' } | { type: 'page'; pageId: string }

export interface TrackCredit {
  source: string
  id: string
  title: string
  author: string
  url: string
  license: string
  required: boolean
}

export interface AudioTrack {
  id: string
  kind: AudioTrackKind
  name: string
  /** `https://…`, a `/media/…` path, or `idb://<uuid>` for a guest's file (the rules of images). */
  src: string
  /** The server asset, when the file is an upload or a recording. */
  assetId?: string
  /** The catalogue id, when the track came from the audio library. */
  libraryId?: string
  /** Where a sound from an online library (Freesound) came from; `required` when it must be credited (CC BY). */
  credit?: TrackCredit
  scope: AudioScope
  /** >= 0: where the track starts, counted from the start of its scope. */
  startMs: number
  /** Length of the whole source file, a hint so the track can be drawn before it is decoded. */
  durationMs?: number
  /** Where in the source the sound starts and ends. */
  trimStartMs: number
  trimEndMs: number
  /** 0..1, linear gain. */
  volume: number
  fadeInMs: number
  fadeOutMs: number
  loop: boolean
  muted: boolean
  /** Lower this track while a voiceover plays. Absent: yes for music, no for the others. */
  duckUnderVoiceover?: boolean
}
