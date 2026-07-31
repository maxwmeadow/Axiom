/**
 * Sheet projection — what a sheet actually is.
 *
 * A sheet is NOT a subset of the map, and it is not a copy of it. It is:
 *
 *   1. a set of POSITION OPINIONS about live nodes, and
 *   2. a set of ADDITIONS that exist only on this sheet.
 *
 * That framing matters because it makes a sheet an *alternative architecture*
 * you can propose — a what-if you can draw, then hand to an agent — rather
 * than a diagram you curate.
 *
 * Two rules follow, and they are the whole design:
 *
 *   LIVE NODES ARE ANCHORED. A sheet may move a live node anywhere, but it can
 *   never delete one. The sheet has opinions about arrangement; reality decides
 *   what exists. "Removing" a live node from a sheet only discards the sheet's
 *   opinion about where it sits, returning it to its Floor position.
 *
 *   NOTHING IS SCENERY. The previous implementation rendered the Floor twice —
 *   a flattened, dimmed, non-interactive base layer plus morphed copies for
 *   sheet members. Duplication forced the base layer to be inert, which is
 *   exactly why working on a sheet felt like drawing on glass over the
 *   architecture instead of in it. Every live node now renders exactly once,
 *   at whichever position applies, fully interactive.
 */

export interface SheetOverride {
  /** Live node this sheet has an opinion about. */
  nodeId: string
  x: number
  y: number
  /** Sheet-local containment, when the sheet re-parents the node. */
  parentSystemId?: string | null
}

interface ProjectableNode {
  id: string
  position: { x: number; y: number }
  parentId?: string
  data?: Record<string, unknown>
  style?: Record<string, unknown>
  draggable?: boolean
  selectable?: boolean
}

/** Absolute world position, so Floor and sheet coordinates are comparable. */
export function absolutePosition<T extends ProjectableNode>(
  node: T,
  byId: Map<string, T>,
): { x: number; y: number } {
  let x = node.position.x
  let y = node.position.y
  let parent = node.parentId ? byId.get(node.parentId) : undefined
  const seen = new Set<string>([node.id])
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id)
    x += parent.position.x
    y += parent.position.y
    parent = parent.parentId ? byId.get(parent.parentId) : undefined
  }
  return { x, y }
}

export interface SheetProjectionResult<T> {
  nodes: T[]
  /** Live nodes this sheet moved, and where from — the transition endpoints. */
  moved: Array<{ id: string; from: { x: number; y: number }; to: { x: number; y: number } }>
}

/**
 * Places live nodes at their sheet positions where the sheet has an opinion,
 * and leaves everything else exactly where the Floor put it.
 *
 * A moved node is flattened to absolute coordinates and detached from its
 * Floor parent, because a sheet arrangement is not bound by Floor containment —
 * that is the point of proposing a different architecture. Unmoved nodes keep
 * their parent relationship untouched, so the Floor's own layout continues to
 * work normally underneath.
 */
export function projectSheetNodes<T extends ProjectableNode>(
  floorNodes: T[],
  overrides: SheetOverride[],
): SheetProjectionResult<T> {
  if (overrides.length === 0) return { nodes: floorNodes, moved: [] }

  const byId = new Map(floorNodes.map(node => [node.id, node]))
  const overrideById = new Map(overrides.map(override => [override.nodeId, override]))
  const moved: SheetProjectionResult<T>['moved'] = []

  const nodes = floorNodes.map(node => {
    const override = overrideById.get(node.id)
    if (!override) return node

    const from = absolutePosition(node, byId)
    const to = { x: override.x, y: override.y }
    moved.push({ id: node.id, from, to })

    return {
      ...node,
      position: to,
      parentId: override.parentSystemId ?? undefined,
      data: { ...node.data, sheetPlaced: true },
    }
  })

  return { nodes, moved }
}

/**
 * Whether a delete gesture may proceed, and what it means if not.
 *
 * A sheet cannot delete reality. Offering a destructive-looking action that
 * silently does something else would be worse than refusing, so this returns
 * the honest outcome and the UI states it.
 */
export type SheetDeleteVerdict =
  | { allowed: true; kind: 'sheet-element' }
  | { allowed: false; kind: 'reset-to-floor'; reason: string }
  | { allowed: false; kind: 'anchored'; reason: string }

export function sheetDeleteVerdict(
  nodeId: string,
  options: { isSheetOnly: boolean; hasOverride: boolean },
): SheetDeleteVerdict {
  // Sheet-only content belongs to the sheet, so the sheet may remove it.
  if (options.isSheetOnly) return { allowed: true, kind: 'sheet-element' }

  if (options.hasOverride) {
    return {
      allowed: false,
      kind: 'reset-to-floor',
      reason: 'Live code is anchored. This returns it to its Floor position instead.',
    }
  }
  return {
    allowed: false,
    kind: 'anchored',
    reason: 'Live code is anchored to the Floor. Delete it from the Floor, not a sheet.',
  }
}
