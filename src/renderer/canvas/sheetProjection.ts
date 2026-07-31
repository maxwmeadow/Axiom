/**
 * Sheet projection — what a sheet actually is.
 *
 * A sheet is NOT a subset of the map, and it is not a copy of it. It is a
 * PROPOSAL, made of three kinds of opinion about the live architecture:
 *
 *   1. MOVES      — where a live node should sit instead
 *   2. ADDITIONS  — things that should exist and do not yet
 *   3. REMOVALS   — things that should go away
 *
 * All three are design intent, which is why removal has to be expressible:
 * "this system should be dissolved" is as much a part of proposing an
 * architecture as drawing a new box. A sheet you cannot delete from can only
 * describe growth.
 *
 * Three rules follow, and they are the whole design:
 *
 *   A PROPOSAL NEVER TOUCHES REALITY. Removing a live node on a sheet takes it
 *   out of that sheet's picture only. The file, the system, the code are all
 *   untouched on the Floor. Leave the sheet and it is simply there again.
 *
 *   A REMOVAL IS ALWAYS RECOVERABLE, AND NOT THROUGH UNDO. Undo is a keystroke
 *   you have to think of in time, and it decays the moment you do something
 *   else. Every removal stays listed on the sheet that made it, restorable long
 *   afterwards, because changing your mind about a proposal is normal rather
 *   than an error to be rescued from.
 *
 *   NOTHING IS SCENERY. The previous implementation rendered the Floor twice —
 *   a flattened, dimmed, non-interactive base layer plus morphed copies for
 *   sheet members. That duplication forced the base layer to be inert, which is
 *   exactly why working on a sheet felt like drawing on glass over the
 *   architecture instead of in it. Every live node now renders exactly once, at
 *   whichever position applies, fully interactive.
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
  /** Live nodes this sheet proposes removing. Absent from `nodes`, never gone. */
  removed: string[]
}

/**
 * Places live nodes at their sheet positions where the sheet has an opinion,
 * omits the ones it proposes removing, and leaves everything else exactly where
 * the Floor put it.
 *
 * A moved node is flattened to absolute coordinates and detached from its Floor
 * parent, because a proposed arrangement is not bound by the current one — that
 * is the point. Unmoved nodes keep their parent relationship untouched, so the
 * Floor's own layout continues to work normally underneath.
 */
export function projectSheetNodes<T extends ProjectableNode>(
  floorNodes: T[],
  overrides: SheetOverride[],
  removedIds: readonly string[] = [],
): SheetProjectionResult<T> {
  if (overrides.length === 0 && removedIds.length === 0) {
    return { nodes: floorNodes, moved: [], removed: [] }
  }

  const byId = new Map(floorNodes.map(node => [node.id, node]))
  const overrideById = new Map(overrides.map(override => [override.nodeId, override]))
  const removedSet = new Set(removedIds)
  const moved: SheetProjectionResult<T>['moved'] = []
  const removed: string[] = []

  const nodes: T[] = []
  for (const node of floorNodes) {
    if (removedSet.has(node.id)) {
      removed.push(node.id)
      continue
    }

    const override = overrideById.get(node.id)
    if (!override) {
      nodes.push(node)
      continue
    }

    const from = absolutePosition(node, byId)
    const to = { x: override.x, y: override.y }
    moved.push({ id: node.id, from, to })

    nodes.push({
      ...node,
      position: to,
      parentId: override.parentSystemId ?? undefined,
      data: { ...node.data, sheetPlaced: true },
    })
  }

  return { nodes, moved, removed }
}

/**
 * What a delete gesture means in the context it was made.
 *
 * Deleting is always allowed. What differs is the consequence, and the UI has
 * to state it rather than let a destructive-looking gesture stay ambiguous —
 * the same key doing something recoverable in one place and permanent in
 * another is exactly the situation that needs labelling.
 */
export type SheetDeleteIntent =
  /** The sheet's own content. Deleting it really deletes it. */
  | { kind: 'sheet-element'; destructive: true; label: string }
  /** Live code, on a sheet. Proposes removal; reality is untouched. */
  | { kind: 'propose-removal'; destructive: false; label: string; restoreHint: string }
  /** Live code, on the Floor. The only place live code actually dies. */
  | { kind: 'delete-live'; destructive: true; label: string }

export function sheetDeleteIntent(options: {
  onSheet: boolean
  isSheetOnly: boolean
}): SheetDeleteIntent {
  if (options.isSheetOnly) {
    return { kind: 'sheet-element', destructive: true, label: 'Delete' }
  }
  if (!options.onSheet) {
    return { kind: 'delete-live', destructive: true, label: 'Delete' }
  }
  return {
    kind: 'propose-removal',
    destructive: false,
    label: 'Remove from sheet',
    restoreHint: 'Kept in Removed on this sheet — restore it any time.',
  }
}

/** One entry in a sheet's Removed list: what was taken out, and enough to name it. */
export interface SheetRemoval {
  nodeId: string
  label: string
  /** False when the node has since left the Floor as well. */
  stillLive: boolean
}

/**
 * The restorable removals for a sheet.
 *
 * A removal whose node has since genuinely disappeared from the Floor is kept
 * and marked rather than silently dropped. "The thing you proposed removing is
 * now actually gone" is information, and quietly erasing the entry would make
 * the list something you cannot trust to be complete.
 */
export function sheetRemovals(
  removedIds: readonly string[],
  liveLabels: ReadonlyMap<string, string>,
): SheetRemoval[] {
  return removedIds.map(nodeId => ({
    nodeId,
    label: liveLabels.get(nodeId) ?? nodeId,
    stillLive: liveLabels.has(nodeId),
  }))
}
