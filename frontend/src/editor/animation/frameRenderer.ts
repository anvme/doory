/**
 * The frame renderer: a page at a moment of its animation, as a bitmap. It is what the editor preview, the slideshow
 * and the video / GIF exporters draw, so it knows nothing about the editor: it takes a page of the document, the time,
 * the size and a `LoadContext` (fonts and image sources), and never touches a live canvas, the history or autosave.
 *
 * How it stays fast: everything that does not change from frame to frame is drawn once. The page is cut along its
 * z-order into layers; each run of objects without animation (and the background) becomes one bitmap, each animated
 * object becomes a bitmap of its own, tight around the object and its shadow. A frame is then a stack of `drawImage`
 * calls with the transforms `sampleObject` asks for, and a frame in which nothing changed is not drawn again. Text
 * that steps through lines, words or letters is cut into one small bitmap per unit when the page is prepared.
 *
 * At rest (every enter finished, no exit started) a frame equals the page as the export renders it.
 */
import { type FabricObject, StaticCanvas } from 'fabric'
import type { DocObject, DocPage } from '@/types/document'
import { type BuiltBackground, buildBackground } from '../engine/objects/background'
import { isVideoObject, videoKey, videoOf } from '../engine/objects/video'
import { renderableObjects } from '../engine/render'
import { type LoadContext, deserializeObjects } from '../engine/serialization'
import { type Surface, context2d, createCanvas, drawBlurred } from './canvasFx'
import { animationOf, type PageTiming, pageTiming } from './model'
import { emphasisPresets, inOutPresets } from './presets'
import { type Box, type PageDims, type Sample, type UnitPlan, isRest, isSplittableText, sampleObject, sampleUnit, unitFor } from './sampler'
import { clipTimeMs } from './videoClip'
import { type VideoFrameSources } from './videoFrames'
import { type SplitBy, type UnitBox, textUnitBoxes } from './textUnits'

const RAD = Math.PI / 180

/** A tile is never larger than this many pixels; a larger object is drawn from a smaller bitmap. */
export const MAX_TILE_PIXELS = 16_000_000
/** Objects further than this many page sizes off the page are not prepared (nothing of them can be seen). */
const OFF_PAGE_MARGIN = 0.25

export interface FrameRendererOptions {
  /** Output pixels per page pixel. */
  multiplier: number
  /** Leave the page background out (a frame with transparency). */
  transparent?: boolean
  /** Where the clips of the page get their frames from; without them the poster frame is drawn. */
  videoFrames?: VideoFrameSources
}

export interface FrameRenderer {
  /** Page size in px. */
  readonly page: PageDims
  /** Size of `canvas` in pixels. */
  readonly width: number
  readonly height: number
  /** The bitmap every call of `render` draws on and returns. Copy it if you need an earlier frame. */
  readonly canvas: HTMLCanvasElement
  readonly timing: PageTiming
  /** Draws the page at `tMs` on the page clock (0 = the page has just come in). Returns `canvas`. */
  render(tMs: number): HTMLCanvasElement
  dispose(): void
}

interface DevicePoint {
  x: number
  y: number
}

/** A bitmap and where it goes, in output pixels. */
interface Placed {
  canvas: HTMLCanvasElement
  x: number
  y: number
  w: number
  h: number
}

interface UnitBitmap extends Placed {
  /** Centre of the unit relative to the object's centre, page px. */
  cx: number
  cy: number
  /** Corners of the unit's box relative to its centre, page px (for units that show only inside their own place). */
  quad: readonly DevicePoint[]
}

interface StaticLayer {
  kind: 'static'
  tile: Placed
}

interface AnimatedLayer {
  kind: 'animated'
  object: DocObject
  box: Box
  tile: Placed
  units: Map<SplitBy, UnitBitmap[]>
}

interface VideoLayer {
  kind: 'video'
  object: DocObject
  box: Box
  /** The poster frame, drawn when the clip has no live frame. */
  tile: Placed
  /** The clip's key: the frame sources are by it. */
  key: string
}

type Layer = StaticLayer | AnimatedLayer | VideoLayer

/* ------------------------------------------------------------------------------------------------
 * Preparing
 * ---------------------------------------------------------------------------------------------- */

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Page px to grow a bounding box by so that the shadow and glow of the object fit in its tile. */
function shadowPad(obj: FabricObject): number {
  const shadow = obj.shadow
  if (!shadow) return 2
  const scale = Math.max(Math.abs(obj.scaleX ?? 1), Math.abs(obj.scaleY ?? 1))
  return Math.ceil((shadow.blur + Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY))) * scale) + 4
}

function unionRect(rects: readonly Rect[]): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w)
    y1 = Math.max(y1, r.y + r.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Paints `objects` (and a background) into a new bitmap that covers `rect` (page px) at `scale` pixels per page px. */
function paint(objects: readonly FabricObject[], background: BuiltBackground | null, rect: Rect, scale: number): HTMLCanvasElement {
  const holder = new StaticCanvas(document.createElement('canvas'), { width: 1, height: 1, renderOnAddRemove: false, enableRetinaScaling: false, skipOffscreen: false })
  try {
    holder.backgroundColor = background?.color ?? ''
    holder.backgroundImage = background?.object
    if (objects.length > 0) holder.add(...objects)
    // Fabric truncates the bitmap's size to whole pixels: a millionth of a pixel more keeps a rounding error from cutting one off.
    return holder.toCanvasElement(scale, { left: rect.x, top: rect.y, width: (Math.round(rect.w * scale) + 1e-6) / scale, height: (Math.round(rect.h * scale) + 1e-6) / scale })
  } finally {
    void holder.dispose()
  }
}

/** The bitmap of a region of the page, placed in output pixels. `scale` may be below the output scale for a huge region. */
function placeTile(objects: readonly FabricObject[], background: BuiltBackground | null, region: Rect, m: number): Placed | null {
  let x0 = Math.floor(region.x * m)
  let y0 = Math.floor(region.y * m)
  let w = Math.ceil((region.x + region.w) * m) - x0
  let h = Math.ceil((region.y + region.h) * m) - y0
  if (w <= 0 || h <= 0) return null
  let scale = m
  if (w * h > MAX_TILE_PIXELS) {
    scale = m * Math.sqrt(MAX_TILE_PIXELS / (w * h))
    x0 = Math.floor(region.x * scale)
    y0 = Math.floor(region.y * scale)
    w = Math.ceil((region.x + region.w) * scale) - x0
    h = Math.ceil((region.y + region.h) * scale) - y0
  }
  const canvas = paint(objects, background, { x: x0 / scale, y: y0 / scale, w: w / scale, h: h / scale }, scale)
  return { canvas, x: (x0 / scale) * m, y: (y0 / scale) * m, w: (w / scale) * m, h: (h / scale) * m }
}

function rotate(x: number, y: number, degrees: number): DevicePoint {
  const r = degrees * RAD
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return { x: x * cos - y * sin, y: x * sin + y * cos }
}

/** One small bitmap per unit: the pixels of the tile inside the unit's box, and nothing of its neighbours. */
function cutUnits(tile: Placed, boxes: readonly UnitBox[], box: Box, m: number): UnitBitmap[] {
  const scaleX = tile.canvas.width / tile.w
  const scaleY = tile.canvas.height / tile.h
  return boxes.map((b) => {
    const corners = [rotate(b.x0, b.y0, box.angle), rotate(b.x1, b.y0, box.angle), rotate(b.x1, b.y1, box.angle), rotate(b.x0, b.y1, box.angle)]
    const centre = { x: (corners[0].x + corners[2].x) / 2, y: (corners[0].y + corners[2].y) / 2 }
    // Corners in pixels of the tile bitmap.
    const px = corners.map((c) => ({ x: (box.cx + c.x) * m * scaleX - tile.x * scaleX, y: (box.cy + c.y) * m * scaleY - tile.y * scaleY }))
    const left = Math.max(0, Math.floor(Math.min(...px.map((p) => p.x))))
    const top = Math.max(0, Math.floor(Math.min(...px.map((p) => p.y))))
    const right = Math.min(tile.canvas.width, Math.ceil(Math.max(...px.map((p) => p.x))))
    const bottom = Math.min(tile.canvas.height, Math.ceil(Math.max(...px.map((p) => p.y))))
    const w = Math.max(1, right - left)
    const h = Math.max(1, bottom - top)
    const bitmap = createCanvas(w, h)
    const ctx = context2d(bitmap)
    ctx.beginPath()
    px.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x - left, p.y - top) : ctx.lineTo(p.x - left, p.y - top)))
    ctx.closePath()
    ctx.clip()
    ctx.drawImage(tile.canvas, -left, -top)
    // Where the bitmap goes, relative to the unit's centre, in output pixels.
    const originX = (tile.x + left / scaleX) - (box.cx + centre.x) * m
    const originY = (tile.y + top / scaleY) - (box.cy + centre.y) * m
    return {
      canvas: bitmap,
      x: originX,
      y: originY,
      w: w / scaleX,
      h: h / scaleY,
      cx: centre.x,
      cy: centre.y,
      quad: corners.map((c) => ({ x: c.x - centre.x, y: c.y - centre.y })),
    }
  })
}

/** The units a text object is animated by: whatever its enter and exit ask for. */
function unitKinds(object: DocObject): SplitBy[] {
  const animation = animationOf(object)
  if (!animation || !isSplittableText(object)) return []
  const kinds = new Set<SplitBy>()
  for (const slot of [animation.enter, animation.exit]) {
    const preset = slot ? inOutPresets.get(slot.preset) : undefined
    if (!slot || !preset) continue
    const by = unitFor(preset, slot, true)
    if (by !== 'object') kinds.add(by)
  }
  return [...kinds]
}

/** True when the object has an animation the registry can play. */
function isAnimated(object: DocObject): boolean {
  const animation = animationOf(object)
  if (!animation) return false
  return [animation.enter, animation.exit].some((a) => a && inOutPresets.has(a.preset)) || (animation.emphasis !== undefined && emphasisPresets.has(animation.emphasis.preset))
}

/* ------------------------------------------------------------------------------------------------
 * Drawing
 * ---------------------------------------------------------------------------------------------- */

/** Draws a bitmap at its place; at its own size the plain form is used (it cannot blend the edge pixels with nothing). */
function drawPlaced(ctx: Surface, p: Placed): void {
  if (p.w === p.canvas.width && p.h === p.canvas.height) ctx.drawImage(p.canvas, p.x, p.y)
  else ctx.drawImage(p.canvas, p.x, p.y, p.w, p.h)
}

function sameUnits(a: UnitPlan | undefined, b: UnitPlan | undefined): boolean {
  if (a === b) return true
  return !!a && !!b && a.by === b.by && a.preset === b.preset && a.phase === b.phase && a.progress === b.progress
}

function sameSample(a: Readonly<Sample>, b: Readonly<Sample>): boolean {
  return (
    a === b ||
    (a.visible === b.visible &&
      a.opacity === b.opacity &&
      a.tx === b.tx &&
      a.ty === b.ty &&
      a.scaleX === b.scaleX &&
      a.scaleY === b.scaleY &&
      a.rotate === b.rotate &&
      a.skewX === b.skewX &&
      a.skewY === b.skewY &&
      a.blur === b.blur &&
      a.clip === b.clip &&
      sameUnits(a.units, b.units))
  )
}

/** Moves the origin to the object's centre and applies the sample's transform about it. */
function transformTo(ctx: Surface, s: Readonly<Sample>, box: Box, m: number): void {
  ctx.translate((box.cx + s.tx) * m, (box.cy + s.ty) * m)
  if (s.rotate !== 0) ctx.rotate(s.rotate * RAD)
  if (s.skewX !== 0 || s.skewY !== 0) ctx.transform(1, Math.tan(s.skewY * RAD), Math.tan(s.skewX * RAD), 1, 0, 0)
  if (s.scaleX !== 1 || s.scaleY !== 1) ctx.scale(s.scaleX, s.scaleY)
}

function clipTo(ctx: Surface, s: Readonly<Sample>, box: Box, m: number): void {
  const clip = s.clip
  if (!clip) return
  ctx.save()
  if (clip.fixed) ctx.translate(box.cx * m, box.cy * m)
  else transformTo(ctx, s, box, m)
  if (box.angle !== 0) ctx.rotate(box.angle * RAD)
  const x0 = (clip.x0 - 0.5) * box.w * m
  const y0 = (clip.y0 - 0.5) * box.h * m
  const w = (clip.x1 - clip.x0) * box.w * m
  const h = (clip.y1 - clip.y0) * box.h * m
  ctx.beginPath()
  if (clip.shape === 'ellipse') ctx.ellipse(x0 + w / 2, y0 + h / 2, Math.max(0, Math.abs(w / 2)), Math.max(0, Math.abs(h / 2)), 0, 0, Math.PI * 2)
  else ctx.rect(x0, y0, w, h)
  ctx.restore()
  ctx.clip()
}

function drawUnits(ctx: Surface, layer: AnimatedLayer, s: Readonly<Sample>, m: number): boolean {
  const plan = s.units
  const units = plan ? layer.units.get(plan.by) : undefined
  if (!plan || !units) return false
  for (let i = 0; i < units.length; i++) {
    const u = units[i]
    const look = sampleUnit(plan, i, units.length, { w: Math.abs(u.quad[2].x - u.quad[0].x), h: Math.abs(u.quad[2].y - u.quad[0].y) })
    if (look.opacity <= 0.001 || look.scaleX === 0 || look.scaleY === 0) continue
    ctx.save()
    ctx.globalAlpha = s.opacity * look.opacity
    transformTo(ctx, s, layer.box, m)
    ctx.translate(u.cx * m, u.cy * m)
    if (look.clipToUnit) {
      ctx.beginPath()
      u.quad.forEach((p, k) => (k === 0 ? ctx.moveTo(p.x * m, p.y * m) : ctx.lineTo(p.x * m, p.y * m)))
      ctx.closePath()
      ctx.clip()
    }
    ctx.translate(look.tx * m, look.ty * m)
    if (look.rotate !== 0) ctx.rotate(look.rotate * RAD)
    if (look.skewX !== 0 || look.skewY !== 0) ctx.transform(1, Math.tan(look.skewY * RAD), Math.tan(look.skewX * RAD), 1, 0, 0)
    if (look.scaleX !== 1 || look.scaleY !== 1) ctx.scale(look.scaleX, look.scaleY)
    drawBlurred(ctx, u.canvas, u.x, u.y, u.w, u.h, look.blur * m)
    ctx.restore()
  }
  return true
}

function drawAnimated(ctx: Surface, layer: AnimatedLayer, s: Readonly<Sample>, m: number): void {
  if (!s.visible) return
  if (isRest(s)) {
    drawPlaced(ctx, layer.tile)
    return
  }
  ctx.save()
  clipTo(ctx, s, layer.box, m)
  ctx.globalAlpha = s.opacity
  if (!drawUnits(ctx, layer, s, m)) {
    // Split text whose units are not available, or a plain object: the whole bitmap, fading with the plan's progress.
    if (s.units) ctx.globalAlpha = s.opacity * (s.units.phase === 'enter' ? s.units.progress : 1 - s.units.progress)
    transformTo(ctx, s, layer.box, m)
    drawBlurred(ctx, layer.tile.canvas, layer.tile.x - layer.box.cx * m, layer.tile.y - layer.box.cy * m, layer.tile.w, layer.tile.h, s.blur * m)
  }
  ctx.restore()
}

/**
 * Draws a clip: its live frame when there is one, its poster frame otherwise. A clip is never baked into a
 * static tile, because its picture changes from frame to frame.
 */
function drawVideo(
  ctx: Surface,
  layer: VideoLayer,
  s: Readonly<Sample>,
  tMs: number,
  m: number,
  sources: VideoFrameSources | undefined,
): void {
  if (!s.visible) return
  const source = sources?.get(layer.key)
  const frame = source ? source.frame(clipTimeMs(layer.object, tMs)) : null
  ctx.save()
  clipTo(ctx, s, layer.box, m)
  ctx.globalAlpha = s.opacity
  transformTo(ctx, s, layer.box, m)
  if (frame) {
    const w = layer.box.w * m
    const h = layer.box.h * m
    drawBlurred(ctx, frame, -w / 2, -h / 2, w, h, s.blur * m)
  } else {
    drawBlurred(
      ctx,
      layer.tile.canvas,
      layer.tile.x - layer.box.cx * m,
      layer.tile.y - layer.box.cy * m,
      layer.tile.w,
      layer.tile.h,
      s.blur * m,
    )
  }
  ctx.restore()
}

/* ------------------------------------------------------------------------------------------------
 * The renderer
 * ---------------------------------------------------------------------------------------------- */

/**
 * Prepares `page` for rendering at `size` (page px) times `options.multiplier`: loads fonts and images through `ctx`,
 * lays the page out in layers and draws their bitmaps. Resolves when `render` can be called.
 */
export async function createFrameRenderer(page: DocPage, size: PageDims, ctx: LoadContext, options: FrameRendererOptions): Promise<FrameRenderer> {
  const m = Math.max(0.05, options.multiplier)
  const docs = renderableObjects(page.objects)
  const [objects, background] = await Promise.all([
    deserializeObjects(docs, ctx),
    options.transparent ? Promise.resolve(null) : buildBackground(page.background, size.width, size.height, (s) => ctx.resolveSrc(s)),
  ])
  // Fabric counts a shape's default 1 px stroke width in its size even without a stroke, which would leave the first row
  // and column of the page half covered.
  background?.object.set({ strokeWidth: 0 })
  const layers: Layer[] = []
  const pageRect: Rect = { x: 0, y: 0, w: size.width, h: size.height }
  const reach: Rect = { x: -size.width * OFF_PAGE_MARGIN, y: -size.height * OFF_PAGE_MARGIN, w: size.width * (1 + 2 * OFF_PAGE_MARGIN), h: size.height * (1 + 2 * OFF_PAGE_MARGIN) }

  let run: FabricObject[] = []
  const flushRun = (first: boolean): void => {
    if (!first && run.length === 0) return
    let region = pageRect
    if (!first) {
      region = intersect(unionRect(run.map((o) => boundsOf(o, shadowPad(o)))), pageRect)
    }
    const tile = region.w > 0 && region.h > 0 ? placeTile(run, first ? background : null, region, m) : null
    if (tile) layers.push({ kind: 'static', tile })
    else for (const o of run) o.dispose()
    run = []
  }
  let first = true
  objects.forEach((obj, i) => {
    const doc = docs[i]
    if (!isAnimated(doc) && !isVideoObject(doc)) {
      run.push(obj)
      return
    }
    flushRun(first)
    first = false
    const centre = obj.getCenterPoint()
    const box: Box = { cx: centre.x, cy: centre.y, w: obj.getScaledWidth(), h: obj.getScaledHeight(), angle: obj.angle ?? 0 }
    const pad = shadowPad(obj)
    const region = intersect(boundsOf(obj, pad), reach)
    const kinds = unitKinds(doc)
    const boxes = new Map<SplitBy, UnitBox[]>()
    for (const by of kinds) {
      const found = textUnitBoxes(obj, by, pad)
      if (found) boxes.set(by, found)
    }
    const tile = region.w > 0 && region.h > 0 ? placeTile([obj], null, region, m) : null
    if (!tile) {
      obj.dispose()
      return
    }
    const video = videoOf(doc)
    if (video) {
      // A clip is drawn from its own frame source, never from a baked tile.
      layers.push({ kind: 'video', object: doc, box, tile, key: videoKey(video) })
      return
    }
    const units = new Map<SplitBy, UnitBitmap[]>()
    for (const [by, list] of boxes) units.set(by, cutUnits(tile, list, box, m))
    layers.push({ kind: 'animated', object: doc, box, tile, units })
  })
  flushRun(first)

  const width = Math.max(1, Math.round(size.width * m))
  const height = Math.max(1, Math.round(size.height * m))
  const canvas = createCanvas(width, height)
  const surface = context2d(canvas)
  const sampled = layers.filter((l): l is AnimatedLayer | VideoLayer => l.kind !== 'static')
  const hasVideo = layers.some((l) => l.kind === 'video')
  let last: Readonly<Sample>[] | null = null
  let disposed = false

  return {
    page: size,
    width,
    height,
    canvas,
    timing: pageTiming(page),
    render(tMs: number): HTMLCanvasElement {
      if (disposed) return canvas
      const samples = sampled.map((layer) => sampleObject(layer.object, tMs, size, layer.box))
      // A clip's picture changes from frame to frame, so the page is drawn again even when nothing moved.
      if (!hasVideo && last && samples.every((s, i) => sameSample(s, last![i]))) return canvas
      last = samples
      surface.setTransform(1, 0, 0, 1, 0, 0)
      surface.globalAlpha = 1
      surface.clearRect(0, 0, width, height)
      let next = 0
      for (const layer of layers) {
        if (layer.kind === 'static') drawPlaced(surface, layer.tile)
        else if (layer.kind === 'video') drawVideo(surface, layer, samples[next++], tMs, m, options.videoFrames)
        else drawAnimated(surface, layer, samples[next++], m)
      }
      return canvas
    },
    dispose(): void {
      disposed = true
      last = null
      layers.length = 0
      canvas.width = 1
      canvas.height = 1
    },
  }
}

/** The bounding box of an object in page px, grown by `by` on every side. */
function boundsOf(obj: FabricObject, by: number): Rect {
  const r = obj.getBoundingRect()
  return { x: r.left - by, y: r.top - by, w: r.width + 2 * by, h: r.height + 2 * by }
}

function intersect(a: Rect, b: Rect): Rect {
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.w, b.x + b.w)
  const y1 = Math.min(a.y + a.h, b.y + b.h)
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

/**
 * One frame in one call: prepares `page`, draws it at `tMs` and gives the bitmap away. For many frames of one page
 * create a renderer and call `render` instead; preparing is most of the work.
 */
export async function renderFrame(page: DocPage, tMs: number, size: PageDims, ctx: LoadContext, options: FrameRendererOptions): Promise<HTMLCanvasElement> {
  const renderer = await createFrameRenderer(page, size, ctx, options)
  const frame = renderer.render(tMs)
  const copy = createCanvas(frame.width, frame.height)
  context2d(copy).drawImage(frame, 0, 0)
  renderer.dispose()
  return copy
}
