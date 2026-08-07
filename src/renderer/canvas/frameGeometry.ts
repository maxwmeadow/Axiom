/**
 * Canonical geometry for Axiom's nested canvas.
 *
 * Positions and sizes are always stored in the immediate parent's coordinate
 * system. `scale` is uniform and applies to the node and its full subtree.
 * Keeping this math independent from React Flow prevents rendering details from
 * becoming persistence semantics.
 */
import type { ContainerInsets } from './resizeGeometry.ts'
import { systemTabHeight } from './systemChrome.ts'

export interface FrameGeometry {
  x: number
  y: number
  width: number
  height: number
  /** This frame's own size in its parent's coordinate space. */
  scale: number
  /**
   * The scale this frame imposes on its CONTENTS, on top of its own. It is
   * deliberately NOT part of the frame's own rendered size, so a container can
   * compress what it holds without its own geometry — or anything derived from
   * that geometry, chrome included — moving at all.
   */
  interiorScale: number
}

/**
 * The factor a frame contributes to its children's world scale. This is the
 * only place the two scales combine; everything describing the frame itself
 * must read `scale` alone.
 */
export function frameContentScale(geometry: Pick<FrameGeometry, 'scale' | 'interiorScale'>): number {
  return geometry.scale * geometry.interiorScale
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface ReferenceFrameTransform {
  scale: number
  anchor: Point
  offset: Point
}

export interface WorldFrame extends Rect {
  /** World scale of the frame itself — drives its own width/height. */
  scale: number
  /** World scale this frame hands to its children. */
  contentScale: number
}

export interface FrameNode {
  id: string
  parentId: string | null
  geometry: FrameGeometry
}

export const DEFAULT_FRAME_SCALE = 1

/**
 * THE gap. One number for every clearance inside a frame: between two
 * occupants, and between an occupant and the frame's own edge.
 *
 * Six different values used to express this idea — 12 for a drop slide, 36 for
 * a newly indexed node, 36 for a fresh pack, 42 for tidy, 28 for the frame
 * inset — so the same arrangement packed differently depending on which code
 * path produced it. Every in-frame path now reads this constant. Changing the
 * breathing room of the whole canvas is changing this line.
 */
export const FRAME_ITEM_GAP = 12

/**
 * Spacing between top-level frames on the open canvas. Deliberately NOT
 * `FRAME_ITEM_GAP`: roots float in unbounded space where the gap reads as
 * separation between unrelated systems, not as packing inside a container.
 */
export const FRAME_ROOT_GAP = 96

/**
 * The only spacing a HAND-PLACED node has to respect.
 *
 * The gaps above are how Axiom arranges things when it is the one deciding —
 * a fresh pack, a tidy, a newly indexed file. They are preferences about how a
 * machine-authored layout should look. They are NOT laws, and treating them as
 * laws is what made a dropped node fly a hundred units away from a system it
 * was nowhere near touching: the drop was legal in every way that matters and
 * got rejected anyway for sitting inside a moat that only exists for tidiness.
 *
 * When a person places a node, where they let go is where it goes. The single
 * exception is that two nodes may not share a line — at zero clearance two
 * borders stack into one thick stroke and the boundary between two nodes stops
 * being readable. A few units of daylight is all that takes, so this is small
 * and, unlike the packing gaps, does not scale with nesting: it exists to keep
 * two RENDERED borders apart, and border thickness does not shrink with depth.
 */
export const DROP_CLEARANCE = 6

/** World-space title font sizes per depth — fixed, no counter-scaling. */
export const DEPTH_TITLE_PX = [24, 14, 10, 8]

/**
 * The band a system/platform frame's tab occupies, in the frame's CANONICAL
 * space. Delegates to `systemTabHeight`, the chrome's own authority, rather
 * than restating the formula — the two used to disagree by more than 2x, which
 * is what made the gap above a frame's first child several times the gap on
 * every other side.
 *
 * The tab draws in RENDERED pixels and is a constant per depth, so a frame
 * nested at half scale spends twice as much of its canonical height on it.
 * That conversion is the reason `worldScale` is required here.
 */
export function frameChromeBand(canonicalHeight: number, depth: number, worldScale = 1): number {
  const scale = Math.max(0.0001, worldScale)
  const depthIndex = Math.max(0, Math.min(depth, DEPTH_TITLE_PX.length - 1))
  return systemTabHeight(DEPTH_TITLE_PX[depthIndex], canonicalHeight * scale) / scale
}

/**
 * The insets a frame's occupants must respect. Three sides are the plain gap.
 * The top is the tab plus that same gap, because a system frame's top border
 * is not where its usable space begins — the tab sits between them. That is
 * the only asymmetry, and it is exactly as tall as the tab really is.
 */
export function frameContentInsets(
  canonicalHeight: number,
  depth: number,
  worldScale = 1,
): ContainerInsets {
  return {
    left: FRAME_ITEM_GAP,
    right: FRAME_ITEM_GAP,
    bottom: FRAME_ITEM_GAP,
    top: frameChromeBand(canonicalHeight, depth, worldScale) + FRAME_ITEM_GAP,
  }
}

export function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function normalizeGeometry(
  geometry: Partial<FrameGeometry>,
  fallback: Pick<FrameGeometry, 'width' | 'height'>,
): FrameGeometry {
  return {
    x: finiteOr(geometry.x, 0),
    y: finiteOr(geometry.y, 0),
    width: Math.max(1, finiteOr(geometry.width, fallback.width)),
    height: Math.max(1, finiteOr(geometry.height, fallback.height)),
    scale: typeof geometry.scale === 'number' && Number.isFinite(geometry.scale) && geometry.scale > 0
      ? geometry.scale
      : DEFAULT_FRAME_SCALE,
    interiorScale: typeof geometry.interiorScale === 'number' && Number.isFinite(geometry.interiorScale) && geometry.interiorScale > 0
      ? geometry.interiorScale
      : DEFAULT_FRAME_SCALE,
  }
}

/**
 * Content rectangle in a container's own canonical coordinate system.
 *
 * Prefer `contentRectFor`, which derives the tab-aware insets from the frame
 * itself. This overload exists for callers that already hold insets.
 */
export function contentRect(
  geometry: Pick<FrameGeometry, 'width' | 'height'>,
  padding = FRAME_ITEM_GAP,
  header = FRAME_ITEM_GAP,
): Rect {
  return {
    x: padding,
    y: header,
    width: Math.max(1, geometry.width - padding * 2),
    height: Math.max(1, geometry.height - header - padding),
  }
}

/**
 * The usable interior of a frame, with the tab band accounted for. Every path
 * that asks "where may a child sit inside this frame?" — drop placement, resize
 * clamping, resize minimums, packing, tidy — must go through here, so they can
 * never disagree about where the frame's usable space begins.
 */
export function contentRectFor(
  geometry: Pick<FrameGeometry, 'width' | 'height'>,
  depth: number,
  worldScale = 1,
): Rect {
  const insets = frameContentInsets(geometry.height, depth, worldScale)
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(1, geometry.width - insets.left - insets.right),
    height: Math.max(1, geometry.height - insets.top - insets.bottom),
  }
}

/** Resolve canonical local geometry to world geometry without mutating it. */
export function toWorldFrame(local: FrameGeometry, parent: WorldFrame | null): WorldFrame {
  // Children live in the parent's CONTENT space, not its own. Positions and
  // sizes therefore both ride `contentScale`; only the frame's own dimensions
  // use its own scale.
  const parentScale = parent?.contentScale ?? 1
  const scale = parentScale * local.scale
  return {
    x: (parent?.x ?? 0) + local.x * parentScale,
    y: (parent?.y ?? 0) + local.y * parentScale,
    width: local.width * scale,
    height: local.height * scale,
    scale,
    contentScale: scale * local.interiorScale,
  }
}

export function worldPointToLocal(point: Point, parent: WorldFrame | null): Point {
  const scale = parent?.contentScale ?? 1
  return {
    x: (point.x - (parent?.x ?? 0)) / scale,
    y: (point.y - (parent?.y ?? 0)) / scale,
  }
}

export function boundsOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const rect of rects) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Fit into a destination without ever enlarging the authored group. */
export function scaleToFit(source: Pick<Rect, 'width' | 'height'>, destination: Pick<Rect, 'width' | 'height'>): number {
  if (source.width <= 0 || source.height <= 0) return 1
  return Math.min(1, destination.width / source.width, destination.height / source.height)
}

/**
 * Fit an authored group into a parent without changing any relative layout.
 * Scaling is centered on the parent. If the scaled bounds still cross a
 * border, translate them back along the opposite of the incoming node's angle
 * from the parent center. This prevents a centered bottom/top drop from
 * introducing unrelated horizontal drift.
 */
export function fitReferenceFrame(
  group: Rect,
  destination: Rect,
  incoming: Rect,
): ReferenceFrameTransform {
  const scale = scaleToFit(group, destination)
  const anchor = {
    x: destination.x + destination.width / 2,
    y: destination.y + destination.height / 2,
  }
  const scaled = {
    x: anchor.x + (group.x - anchor.x) * scale,
    y: anchor.y + (group.y - anchor.y) * scale,
    width: group.width * scale,
    height: group.height * scale,
  }
  const minX = destination.x - scaled.x
  const maxX = destination.x + destination.width - (scaled.x + scaled.width)
  const minY = destination.y - scaled.y
  const maxY = destination.y + destination.height - (scaled.y + scaled.height)
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  const fallback = { x: clamp(0, minX, maxX), y: clamp(0, minY, maxY) }

  const incomingCenter = {
    x: incoming.x + incoming.width / 2,
    y: incoming.y + incoming.height / 2,
  }
  const dx = incomingCenter.x - anchor.x
  const dy = incomingCenter.y - anchor.y
  const length = Math.hypot(dx, dy)
  if (length < 0.0001) return { scale, anchor, offset: fallback }

  // offset = coefficient * distance, where coefficient points from the
  // incoming node back toward the parent center.
  const coefficients = [-dx / length, -dy / length]
  const ranges: Array<[number, number]> = [[minX, maxX], [minY, maxY]]
  let distanceMin = 0
  let distanceMax = Number.POSITIVE_INFINITY
  for (let index = 0; index < coefficients.length; index++) {
    const coefficient = coefficients[index]
    const [minOffset, maxOffset] = ranges[index]
    if (Math.abs(coefficient) < 0.000001) {
      if (minOffset > 0 || maxOffset < 0) return { scale, anchor, offset: fallback }
      continue
    }
    const first = minOffset / coefficient
    const second = maxOffset / coefficient
    distanceMin = Math.max(distanceMin, Math.min(first, second))
    distanceMax = Math.min(distanceMax, Math.max(first, second))
  }
  if (distanceMin > distanceMax || distanceMax < 0) return { scale, anchor, offset: fallback }
  const distance = Math.max(0, distanceMin)
  return {
    scale,
    anchor,
    offset: { x: coefficients[0] * distance, y: coefficients[1] * distance },
  }
}

export function transformReferencePoint(point: Point, transform: ReferenceFrameTransform): Point {
  return {
    x: transform.anchor.x + (point.x - transform.anchor.x) * transform.scale + transform.offset.x,
    y: transform.anchor.y + (point.y - transform.anchor.y) * transform.scale + transform.offset.y,
  }
}

/** Convert a world-space group fit into the node's new parent-local scale. */
export function localScaleAfterWorldFit(
  oldWorldScale: number,
  fit: number,
  targetWorldScale = 1,
): number {
  const safeTargetScale = Number.isFinite(targetWorldScale) && targetWorldScale > 0
    ? targetWorldScale
    : DEFAULT_FRAME_SCALE
  const next = oldWorldScale * fit / safeTargetScale
  return Number.isFinite(next) && next > 0 ? next : DEFAULT_FRAME_SCALE
}

/**
 * Remove selected descendants when an ancestor is selected. Only these roots
 * should be independently transformed or persisted during a group operation.
 */
export function highestSelectedRoots(selectedIds: Iterable<string>, parentById: ReadonlyMap<string, string | null>): string[] {
  const selected = new Set(selectedIds)
  return [...selected].filter(id => {
    const visited = new Set<string>([id])
    let parent = parentById.get(id) ?? null
    while (parent && !visited.has(parent)) {
      if (selected.has(parent)) return false
      visited.add(parent)
      parent = parentById.get(parent) ?? null
    }
    return true
  })
}

export function isDescendant(candidateId: string, ancestorId: string, parentById: ReadonlyMap<string, string | null>): boolean {
  const visited = new Set<string>()
  let current: string | null = candidateId
  while (current && !visited.has(current)) {
    if (current === ancestorId) return true
    visited.add(current)
    current = parentById.get(current) ?? null
  }
  return false
}
