import type { Node } from '@xyflow/react'

export interface LivingRect {
  x: number
  y: number
  width: number
  height: number
}

export type LivingAnchorSide = 'top' | 'right' | 'bottom' | 'left'

export interface LivingAnchorPair {
  sourceSide: LivingAnchorSide
  targetSide: LivingAnchorSide
  sourceHandle: string
  targetHandle: string
}

export interface LivingBoundaryAnchors extends LivingAnchorPair {
  source: LivingPoint
  target: LivingPoint
}

export interface LivingPoint {
  x: number
  y: number
}

export interface LivingPulseGeometry {
  /** Approximate route length after the current viewport transform. */
  screenLength: number
  /** Normalized visible portion of a pathLength=1 SVG stroke. */
  headFraction: number
  /** Normalized gap behind the moving segment. Sized so the dash period stays
   *  longer than the route and the pattern cannot tile a second pulse. */
  tailFraction: number
  /** stroke-dashoffset at 0%: pulse sits entirely before the origin. */
  dashStart: number
  /** stroke-dashoffset at 100%: pulse sits entirely past the destination. */
  dashEnd: number
}

function positiveDimension(...values: unknown[]): number {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 1
}

/**
 * Resolves stable world-space geometry without React Flow's transient
 * measurement cache. Hidden nodes can briefly report measured=0 while their
 * authored style still contains the canonical dimensions.
 */
export function absoluteLivingNodeRect(
  nodeId: string,
  nodes: readonly Node[],
): LivingRect | null {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const origin = byId.get(nodeId)
  if (!origin) return null

  let x = origin.position?.x ?? 0
  let y = origin.position?.y ?? 0
  let parentId = origin.parentId
  const seen = new Set<string>([origin.id])
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) return null
    x += parent.position?.x ?? 0
    y += parent.position?.y ?? 0
    parentId = parent.parentId
  }

  return {
    x,
    y,
    width: positiveDimension(origin.measured?.width, origin.style?.width),
    height: positiveDimension(origin.measured?.height, origin.style?.height),
  }
}

export function livingAnchorPoint(rect: LivingRect, side: LivingAnchorSide): LivingPoint {
  if (side === 'top') return { x: rect.x + rect.width / 2, y: rect.y }
  if (side === 'right') return { x: rect.x + rect.width, y: rect.y + rect.height / 2 }
  if (side === 'bottom') return { x: rect.x + rect.width / 2, y: rect.y + rect.height }
  return { x: rect.x, y: rect.y + rect.height / 2 }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function closestAxisPoints(
  sourceMin: number,
  sourceMax: number,
  targetMin: number,
  targetMax: number,
): { source: number; target: number; gap: number } {
  if (sourceMax <= targetMin) {
    return { source: sourceMax, target: targetMin, gap: targetMin - sourceMax }
  }
  if (targetMax <= sourceMin) {
    return { source: sourceMin, target: targetMax, gap: sourceMin - targetMax }
  }

  const overlapMidpoint =
    (Math.max(sourceMin, targetMin) + Math.min(sourceMax, targetMax)) / 2
  return { source: overlapMidpoint, target: overlapMidpoint, gap: 0 }
}

/**
 * Finds the shortest pair of points on two axis-aligned node boundaries.
 * Side-midpoint routing can visibly travel past the nearest part of an offset
 * card and read like it is entering the card. Aligned nodes meet at the
 * midpoint of their overlapping span; diagonal nodes meet at their nearest
 * corners. The returned points are always clamped to the authored perimeter.
 */
export function chooseClosestLivingBoundaryAnchors(
  sourceRect: LivingRect,
  targetRect: LivingRect,
): LivingBoundaryAnchors {
  const x = closestAxisPoints(
    sourceRect.x,
    sourceRect.x + sourceRect.width,
    targetRect.x,
    targetRect.x + targetRect.width,
  )
  const y = closestAxisPoints(
    sourceRect.y,
    sourceRect.y + sourceRect.height,
    targetRect.y,
    targetRect.y + targetRect.height,
  )

  // Overlapping rectangles have no external shortest segment. Preserve the
  // established opposing-face fallback instead of creating a zero-length path
  // in the middle of both nodes.
  if (x.gap === 0 && y.gap === 0) {
    const pair = chooseLivingAnchorPair(sourceRect, targetRect)
    return {
      ...pair,
      source: livingAnchorPoint(sourceRect, pair.sourceSide),
      target: livingAnchorPoint(targetRect, pair.targetSide),
    }
  }

  let sourceSide: LivingAnchorSide
  let targetSide: LivingAnchorSide
  if (x.gap > 0 && (y.gap === 0 || x.gap >= y.gap)) {
    const targetIsRight = targetRect.x >= sourceRect.x + sourceRect.width
    sourceSide = targetIsRight ? 'right' : 'left'
    targetSide = targetIsRight ? 'left' : 'right'
  } else {
    const targetIsBelow = targetRect.y >= sourceRect.y + sourceRect.height
    sourceSide = targetIsBelow ? 'bottom' : 'top'
    targetSide = targetIsBelow ? 'top' : 'bottom'
  }

  return {
    sourceSide,
    targetSide,
    sourceHandle: `source-${sourceSide}`,
    targetHandle: `target-${targetSide}`,
    source: {
      x: clamp(x.source, sourceRect.x, sourceRect.x + sourceRect.width),
      y: clamp(y.source, sourceRect.y, sourceRect.y + sourceRect.height),
    },
    target: {
      x: clamp(x.target, targetRect.x, targetRect.x + targetRect.width),
      y: clamp(y.target, targetRect.y, targetRect.y + targetRect.height),
    },
  }
}

/**
 * Keeps the travelling segment visually useful at every scale. A fixed
 * normalized dash becomes a tiny spark on short routes and a giant bar on
 * long routes. This targets a 34-92px comet, while clamping its normalized
 * share so very short routes still visibly travel instead of looking solid.
 */
export function livingPulseGeometry(
  source: LivingPoint,
  target: LivingPoint,
  zoom: number,
): LivingPulseGeometry {
  const worldLength = Math.max(
    1,
    Math.abs(target.x - source.x) + Math.abs(target.y - source.y),
  )
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const screenLength = worldLength * safeZoom
  const targetPixels = Math.max(34, Math.min(92, screenLength * 0.22))
  const headFraction = Math.max(0.1, Math.min(0.42, targetPixels / screenLength))

  // An SVG dash pattern repeats forever along the path. A period of exactly 1
  // (head + gap === the whole route) parks a duplicate dash one full route
  // behind the travelling one, so it slides in from the origin as the real
  // pulse leaves the destination and reads as a second, stunted shot. Any
  // period above 1 + head keeps every neighbouring tile outside [0, 1] for the
  // entire travel; the extra head of slack keeps the round linecap from
  // grazing an endpoint.
  const tailFraction = 1 + headFraction
  const period = headFraction + tailFraction

  return {
    screenLength,
    headFraction,
    tailFraction,
    dashStart: period + headFraction,
    dashEnd: period - 1,
  }
}

/**
 * Chooses opposing nearest faces using normalized center separation. Unlike a
 * fixed first-handle fallback, this never sends a leftward flow out the right
 * side or a vertical flow sideways along a node boundary.
 */
export function chooseLivingAnchorPair(source: LivingRect, target: LivingRect): LivingAnchorPair {
  const sourceCenter = {
    x: source.x + source.width / 2,
    y: source.y + source.height / 2,
  }
  const targetCenter = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  }
  const dx = targetCenter.x - sourceCenter.x
  const dy = targetCenter.y - sourceCenter.y
  const normalizedX = Math.abs(dx) / Math.max(1, (source.width + target.width) / 2)
  const normalizedY = Math.abs(dy) / Math.max(1, (source.height + target.height) / 2)

  let sourceSide: LivingAnchorSide
  let targetSide: LivingAnchorSide
  if (normalizedX >= normalizedY) {
    sourceSide = dx >= 0 ? 'right' : 'left'
    targetSide = dx >= 0 ? 'left' : 'right'
  } else {
    sourceSide = dy >= 0 ? 'bottom' : 'top'
    targetSide = dy >= 0 ? 'top' : 'bottom'
  }

  return {
    sourceSide,
    targetSide,
    sourceHandle: `source-${sourceSide}`,
    targetHandle: `target-${targetSide}`,
  }
}
