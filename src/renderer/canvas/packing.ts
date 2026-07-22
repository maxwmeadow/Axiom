/**
 * Organic frame packing.
 *
 * Places children inside a frame as a tight cluster rather than filling
 * strict rows: items grow greedily around an anchor, each newcomer snapping
 * flush to a neighbor's edge. Edges align; gaps are not forced onto a grid
 * pitch — `baseGap` is the minimum breathing room and the spacing between
 * non-adjacent neighbors is whatever the cluster geometry produces. The
 * algorithm is fully deterministic: the same contents always pack the same.
 *
 * Coordinates are in the frame's canonical content space with the cluster
 * normalized to a (0,0) origin; callers offset by their content-rect origin.
 */

export interface PackItem {
  id: string
  width: number
  height: number
}

export interface PackOptions {
  /** Minimum breathing room between items. */
  baseGap: number
  /** Target cluster width/height ratio. */
  aspect?: number
}

export interface PackResult {
  positions: Map<string, { x: number; y: number }>
  width: number
  height: number
}

interface PlacedRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

// Absorbs float error so a rect placed exactly baseGap from its anchor is
// not rejected by its own clearance check.
const CLEARANCE_EPSILON = 0.5

function collides(x: number, y: number, width: number, height: number, placed: readonly PlacedRect[], clearance: number): boolean {
  for (const rect of placed) {
    if (x < rect.x + rect.width + clearance && x + width + clearance > rect.x &&
        y < rect.y + rect.height + clearance && y + height + clearance > rect.y) return true
  }
  return false
}

/**
 * Candidate spots sit exactly `gap` off one side of a placed rect, aligned
 * flush with that rect's near or far edge along the other axis.
 */
function candidatesAround(anchor: PlacedRect, item: PackItem, gap: number): Array<{ x: number; y: number }> {
  const rightX = anchor.x + anchor.width + gap
  const leftX = anchor.x - gap - item.width
  const belowY = anchor.y + anchor.height + gap
  const aboveY = anchor.y - gap - item.height
  const topY = anchor.y
  const bottomY = anchor.y + anchor.height - item.height
  const leftAlignX = anchor.x
  const rightAlignX = anchor.x + anchor.width - item.width
  return [
    { x: rightX, y: topY },
    { x: rightX, y: bottomY },
    { x: leftX, y: topY },
    { x: leftX, y: bottomY },
    { x: leftAlignX, y: belowY },
    { x: rightAlignX, y: belowY },
    { x: leftAlignX, y: aboveY },
    { x: rightAlignX, y: aboveY },
  ]
}

/**
 * Pack items into a tight cluster. Larger items are placed first so they
 * anchor the composition; each following item takes the valid candidate that
 * keeps the cluster bounding box tightest (biased toward `aspect`) and
 * closest to the cluster centroid. Ties resolve by candidate order, which is
 * deterministic.
 */
export function packFrame(items: readonly PackItem[], options: PackOptions): PackResult {
  const positions = new Map<string, { x: number; y: number }>()
  if (items.length === 0) return { positions, width: 0, height: 0 }

  const { baseGap } = options
  const aspect = options.aspect && Number.isFinite(options.aspect) && options.aspect > 0 ? options.aspect : 1.45
  const minClearance = baseGap - CLEARANCE_EPSILON
  const ordered = [...items].sort((left, right) =>
    right.width * right.height - left.width * left.height || left.id.localeCompare(right.id))

  const placed: PlacedRect[] = []
  let minX = 0, minY = 0, maxX = 0, maxY = 0
  let centroidX = 0, centroidY = 0

  for (const item of ordered) {
    if (placed.length === 0) {
      placed.push({ id: item.id, x: 0, y: 0, width: item.width, height: item.height })
      maxX = item.width
      maxY = item.height
      centroidX = item.width / 2
      centroidY = item.height / 2
      continue
    }

    let best: { x: number; y: number } | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const anchor of placed) {
      for (const candidate of candidatesAround(anchor, item, baseGap)) {
        if (collides(candidate.x, candidate.y, item.width, item.height, placed, minClearance)) continue
        const boundsW = Math.max(maxX, candidate.x + item.width) - Math.min(minX, candidate.x)
        const boundsH = Math.max(maxY, candidate.y + item.height) - Math.min(minY, candidate.y)
        const squareness = Math.max(boundsW / aspect, boundsH)
        const centerDX = candidate.x + item.width / 2 - centroidX
        const centerDY = candidate.y + item.height / 2 - centroidY
        const score = squareness * squareness * 0.001 + Math.hypot(centerDX, centerDY) * 0.05
        if (score < bestScore) {
          bestScore = score
          best = candidate
        }
      }
    }
    // A cluster always has free space just past its right edge.
    const spot = best ?? { x: maxX + baseGap, y: minY }
    placed.push({ id: item.id, x: spot.x, y: spot.y, width: item.width, height: item.height })
    minX = Math.min(minX, spot.x)
    minY = Math.min(minY, spot.y)
    maxX = Math.max(maxX, spot.x + item.width)
    maxY = Math.max(maxY, spot.y + item.height)
    centroidX = 0
    centroidY = 0
    for (const rect of placed) {
      centroidX += rect.x + rect.width / 2
      centroidY += rect.y + rect.height / 2
    }
    centroidX /= placed.length
    centroidY /= placed.length
  }

  for (const rect of placed) positions.set(rect.id, { x: rect.x - minX, y: rect.y - minY })
  return { positions, width: maxX - minX, height: maxY - minY }
}

/**
 * Find a spot for one newcomer among already-positioned rects (e.g. a file
 * indexed after the initial layout was persisted). Reuses the cluster
 * candidate machinery; falls back to the cluster's right edge, and to
 * `origin` when nothing is placed yet.
 */
export function placeIncoming(
  item: PackItem,
  occupied: readonly { x: number; y: number; width: number; height: number }[],
  options: PackOptions & { origin?: { x: number; y: number } },
): { x: number; y: number } {
  const origin = options.origin ?? { x: 0, y: 0 }
  if (occupied.length === 0) return { x: origin.x, y: origin.y }
  const placed: PlacedRect[] = occupied.map((rect, index) => ({
    id: 'occupied:' + index,
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
  }))
  const minClearance = options.baseGap - CLEARANCE_EPSILON

  let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY
  let centroidX = 0, centroidY = 0
  for (const rect of placed) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
    centroidX += rect.x + rect.width / 2
    centroidY += rect.y + rect.height / 2
  }
  centroidX /= placed.length
  centroidY /= placed.length

  let best: { x: number; y: number } | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const anchor of placed) {
    for (const candidate of candidatesAround(anchor, item, options.baseGap)) {
      if (candidate.x < origin.x || candidate.y < origin.y) continue
      if (collides(candidate.x, candidate.y, item.width, item.height, placed, minClearance)) continue
      const boundsW = Math.max(maxX, candidate.x + item.width) - Math.min(minX, candidate.x)
      const boundsH = Math.max(maxY, candidate.y + item.height) - Math.min(minY, candidate.y)
      const score = Math.max(boundsW, boundsH) +
        Math.hypot(candidate.x + item.width / 2 - centroidX, candidate.y + item.height / 2 - centroidY) * 0.25
      if (score < bestScore) {
        bestScore = score
        best = candidate
      }
    }
  }
  return best ?? { x: maxX + options.baseGap, y: Math.max(origin.y, minY) }
}
