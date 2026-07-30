/**
 * Multi-selection resize.
 *
 * Dragging a handle on one node of a multi-selection resizes the selection as
 * a single frame, the same way dragging one node moves them all together. The
 * transform is the affine map that takes the grabbed node's starting rect onto
 * its new rect, applied to every other selected node. Because the resizer
 * already folds the moved edge into the new origin, this anchors correctly for
 * all eight handles without special-casing north/west.
 */
export interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SelectionMember extends SelectionRect {
  id: string
}

export interface SelectionResizeLimits {
  /** Smallest permitted edge, in the same units as the rects. */
  minWidth: number
  minHeight: number
}

/**
 * Whether `inner` sits entirely inside `outer`. Drop targeting and resize
 * clamping both need containment of a whole rect: testing only the pointer
 * lets an edge escape its frame without registering.
 */
export function rectContainsRect(
  outer: SelectionRect,
  inner: SelectionRect,
): boolean {
  return inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
}

export function selectionResizeScale(
  start: SelectionRect,
  next: SelectionRect,
): { sx: number; sy: number } {
  const sx = start.width > 0 ? next.width / start.width : 1
  const sy = start.height > 0 ? next.height / start.height : 1
  return {
    sx: Number.isFinite(sx) && sx > 0 ? sx : 1,
    sy: Number.isFinite(sy) && sy > 0 ? sy : 1,
  }
}

/**
 * Rects for every non-anchor member after the gesture. Members are expected to
 * share the anchor's coordinate space (same parent); callers filter first,
 * because a node parented elsewhere measures its position against a different
 * origin and cannot be transformed by this map.
 */
export function scaleSelectionRects(
  start: SelectionRect,
  next: SelectionRect,
  members: readonly SelectionMember[],
  limits: SelectionResizeLimits,
): SelectionMember[] {
  const { sx, sy } = selectionResizeScale(start, next)
  return members.map(member => ({
    id: member.id,
    x: next.x + (member.x - start.x) * sx,
    y: next.y + (member.y - start.y) * sy,
    width: Math.max(limits.minWidth, member.width * sx),
    height: Math.max(limits.minHeight, member.height * sy),
  }))
}
