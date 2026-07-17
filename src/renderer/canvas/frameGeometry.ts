/**
 * Canonical geometry for Axiom's nested canvas.
 *
 * Positions and sizes are always stored in the immediate parent's coordinate
 * system. `scale` is uniform and applies to the node and its full subtree.
 * Keeping this math independent from React Flow prevents rendering details from
 * becoming persistence semantics.
 */
export interface FrameGeometry {
  x: number
  y: number
  width: number
  height: number
  scale: number
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
  scale: number
}

export interface FrameNode {
  id: string
  parentId: string | null
  geometry: FrameGeometry
}

export const DEFAULT_FRAME_SCALE = 1
export const FRAME_CONTENT_PADDING = 28
export const FRAME_HEADER_HEIGHT = 54

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
  }
}

/** Content rectangle in a container's own canonical coordinate system. */
export function contentRect(
  geometry: Pick<FrameGeometry, 'width' | 'height'>,
  padding = FRAME_CONTENT_PADDING,
  header = FRAME_HEADER_HEIGHT,
): Rect {
  return {
    x: padding,
    y: header,
    width: Math.max(1, geometry.width - padding * 2),
    height: Math.max(1, geometry.height - header - padding),
  }
}

/** Resolve canonical local geometry to world geometry without mutating it. */
export function toWorldFrame(local: FrameGeometry, parent: WorldFrame | null): WorldFrame {
  const parentScale = parent?.scale ?? 1
  const scale = parentScale * local.scale
  return {
    x: (parent?.x ?? 0) + local.x * parentScale,
    y: (parent?.y ?? 0) + local.y * parentScale,
    width: local.width * scale,
    height: local.height * scale,
    scale,
  }
}

export function worldPointToLocal(point: Point, parent: WorldFrame | null): Point {
  const scale = parent?.scale ?? 1
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

type Interval = [number, number]

function translationInterval(minOffset: number, maxOffset: number, delta: number): Interval | null {
  if (Math.abs(delta) < 0.000001) return minOffset <= 0 && maxOffset >= 0
    ? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
    : null
  const first = minOffset / delta
  const second = maxOffset / delta
  return [Math.min(first, second), Math.max(first, second)]
}

function overlapInterval(moving: Rect, obstacle: Rect, delta: Point): Interval | null {
  const x = translationInterval(obstacle.x - (moving.x + moving.width), obstacle.x + obstacle.width - moving.x, delta.x)
  const y = translationInterval(obstacle.y - (moving.y + moving.height), obstacle.y + obstacle.height - moving.y, delta.y)
  if (!x || !y) return null
  const start = Math.max(x[0], y[0])
  const end = Math.min(x[1], y[1])
  return start < end ? [start, end] : null
}

function freeTravelIntervals(moving: Rect, destination: Rect, obstacles: readonly Rect[], delta: Point): Interval[] {
  const x = translationInterval(destination.x - moving.x, destination.x + destination.width - (moving.x + moving.width), delta.x)
  const y = translationInterval(destination.y - moving.y, destination.y + destination.height - (moving.y + moving.height), delta.y)
  if (!x || !y) return []
  const contained: Interval = [Math.max(0, x[0], y[0]), Math.min(1, x[1], y[1])]
  if (contained[0] > contained[1]) return []

  const blocked = obstacles
    .map(obstacle => overlapInterval(moving, obstacle, delta))
    .filter((interval): interval is Interval => !!interval)
    .map(([start, end]) => [Math.max(contained[0], start), Math.min(contained[1], end)] as Interval)
    .filter(([start, end]) => start < end)
    .sort((left, right) => left[0] - right[0])
  const free: Interval[] = []
  let cursor = contained[0]
  for (const [start, end] of blocked) {
    if (start > cursor) free.push([cursor, start])
    cursor = Math.max(cursor, end)
  }
  if (cursor <= contained[1]) free.push([cursor, contained[1]])
  return free.filter(([start, end]) => end - start > 0.0001)
}

function offsetAtIntervalMidpoint(interval: Interval, delta: Point): Point {
  const midpoint = (interval[0] + interval[1]) / 2
  return { x: delta.x * midpoint, y: delta.y * midpoint }
}

/**
 * Try to place only the incoming frame before resorting to shrinking every
 * child in the destination. Wall-directed space is preferred; the second
 * choice is available space along the incoming-to-parent-center line.
 */
export function findUnscaledIncomingPlacement(
  incoming: Rect,
  destination: Rect,
  occupied: readonly Rect[],
  gap = 12,
): Point | null {
  const destinationRight = destination.x + destination.width
  const destinationBottom = destination.y + destination.height
  const incomingRight = incoming.x + incoming.width
  const incomingBottom = incoming.y + incoming.height
  const crossesLeft = incoming.x < destination.x
  const crossesRight = incomingRight > destinationRight
  const crossesTop = incoming.y < destination.y
  const crossesBottom = incomingBottom > destinationBottom
  if (!crossesLeft && !crossesRight && !crossesTop && !crossesBottom) return { x: 0, y: 0 }
  if (incoming.width > destination.width || incoming.height > destination.height) return null

  const paddedOccupied = occupied.map(rect => ({
    x: rect.x - gap,
    y: rect.y - gap,
    width: rect.width + gap * 2,
    height: rect.height + gap * 2,
  }))
  const wallDelta = {
    x: crossesRight ? destination.x - incoming.x
      : crossesLeft ? destinationRight - incomingRight : 0,
    y: crossesBottom ? destination.y - incoming.y
      : crossesTop ? destinationBottom - incomingBottom : 0,
  }
  const wallIntervals = freeTravelIntervals(incoming, destination, paddedOccupied, wallDelta)
  if (wallIntervals.length > 0) {
    const largest = wallIntervals.reduce((best, interval) =>
      interval[1] - interval[0] > best[1] - best[0] ? interval : best)
    return offsetAtIntervalMidpoint(largest, wallDelta)
  }

  const parentCenter = { x: destination.x + destination.width / 2, y: destination.y + destination.height / 2 }
  const incomingCenter = { x: incoming.x + incoming.width / 2, y: incoming.y + incoming.height / 2 }
  const centerDelta = { x: parentCenter.x - incomingCenter.x, y: parentCenter.y - incomingCenter.y }
  const centerIntervals = freeTravelIntervals(incoming, destination, paddedOccupied, centerDelta)
  if (centerIntervals.length === 0) return null
  const nearestHalf = centerIntervals.reduce((best, interval) => {
    const distance = Math.abs((interval[0] + interval[1]) / 2 - 0.5)
    const bestDistance = Math.abs((best[0] + best[1]) / 2 - 0.5)
    return distance < bestDistance ? interval : best
  })
  return offsetAtIntervalMidpoint(nearestHalf, centerDelta)
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
