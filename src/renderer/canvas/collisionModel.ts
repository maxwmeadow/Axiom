/**
 * The canvas's collision geometry, made visible.
 *
 * This module answers one question — "what boxes does the placement engine
 * actually see right now?" — and it answers it by CALLING the engine, not by
 * restating it. `buildDropFrame` here is the same function `planCanvasDrop`
 * runs on release, and every rect comes from `nodeGeometry`, the same readers
 * the engine uses. A drawn box that disagrees with behaviour is therefore a
 * real bug in the engine, never a stale copy in the debug view. That property
 * is the entire point of the tool and must not be traded away for convenience.
 *
 * The Floor and a Sheet produce the same model from the same code. They differ
 * only in `layer` (which decides how it is painted) and in `editableNodeIds`
 * (which decides what a gesture is allowed to move). If a future change makes
 * the two layers need different geometry here, that is the bug.
 */
import type { Node } from '@xyflow/react'
import {
  buildDropFrame,
  worldPositionFor,
  type DropResolution,
} from './dropPersistence.ts'
import {
  boundsOf,
  highestSelectedRoots,
  type Point,
  type Rect,
} from './frameGeometry.ts'
import {
  clearanceRect,
  conflictsAt,
  dropClearance,
  frameWorldContentRect,
  isFrameNode,
  nodeSizeDisagreement,
  nodeWorldRect,
  packingGapWithin,
  separationBetween,
  type WorldGap,
} from './nodeGeometry.ts'

export type CanvasLayer = 'floor' | 'sheet'

export type CollisionBoxKind =
  /** The rect collision tests against — measured size at absolute position. */
  | 'node'
  /** A frame's usable interior: borders and tab band already removed. */
  | 'content'
  /** A node's rect grown by the clearance that applies where it sits. */
  | 'clearance'
  /** The live drop target's interior — the box the drop is contained within. */
  | 'destination'
  /** Bounds of the group being dragged, where the pointer currently holds it. */
  | 'incoming'
  /** Where the engine would put that group if the pointer released now. */
  | 'landing'
  /** An occupant whose clearance the incoming group currently violates. */
  | 'blocker'

export interface CollisionBox {
  key: string
  kind: CollisionBoxKind
  rect: Rect
  /** Short human label drawn beside the box. */
  label: string
  nodeId: string | null
  /** Clearance this box was grown by, for `clearance` boxes. */
  gap: number | null
}

export type CollisionIssueCode =
  | 'missing-absolute'
  | 'size-disagreement'
  | 'escapes-parent'
  | 'sibling-conflict'
  | 'frame-too-small'

export interface CollisionIssue {
  code: CollisionIssueCode
  severity: 'error' | 'warn'
  message: string
  nodeIds: string[]
}

export interface CollisionNeighbour {
  nodeId: string
  /** Edge-to-edge separation on the tighter axis. Negative means overlap. */
  separation: number
  /** Clearance required between these two. */
  required: number
}

export interface CollisionDragReport {
  draggedNodeId: string
  /** Every node moving with the gesture, ancestors collapsed. */
  movingNodeIds: string[]
  targetNodeId: string | null
  /** Null on the Floor, where roots have no containing frame. */
  destination: Rect | null
  incoming: Rect
  landing: Rect | null
  /** How far the engine pushed the group away from where it is being held. */
  repelDistance: number
  resolution: DropResolution
  changesParent: boolean
  /** The only distance this drop could fail — what the blockers are measured against. */
  clearance: WorldGap
  /** Where it would be offered a resting spot if it does have to move. */
  packingGap: WorldGap
  /** Occupants blocking the released position, nearest first. */
  blockers: CollisionNeighbour[]
  /** Occupants nearest the LANDING spot — the boxes that chose it. */
  landingNeighbours: CollisionNeighbour[]
  /**
   * True when the landing rect is indicative rather than exact: interior
   * compression rewrites the frame's content scale, so the group's final world
   * rect is not a translation of where it is being held.
   */
  landingApproximate: boolean
}

export interface CollisionModel {
  layer: CanvasLayer
  boxes: CollisionBox[]
  issues: CollisionIssue[]
  drag: CollisionDragReport | null
  /** The one rule: the distance no placement may come closer than. */
  clearance: WorldGap
  /**
   * Preferred spacing per container, keyed by frame id; `null` is the root
   * plane. A preference, not a rule — nothing is ever rejected for it.
   */
  gaps: Array<{ frameId: string | null; label: string; gap: WorldGap }>
  nodeCount: number
  frameCount: number
  /** Nodes this layer permits the gesture to move. Null means "all of them". */
  editableCount: number | null
}

export interface CollisionModelInput {
  layer: CanvasLayer
  nodes: Node[]
  absolutePositions: ReadonlyMap<string, Point>
  /** The node under the pointer, if a drag is in flight. */
  draggedNodeId?: string | null
  /** The frame the cursor is currently over, if any. */
  targetNodeId?: string | null
  editableNodeIds?: ReadonlySet<string> | null
}

/** Rects touching within this many world units are treated as flush. */
const TOLERANCE = 0.5

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function shortId(id: string): string {
  const withoutPrefix = id.startsWith('planned:') ? id.slice(8) : id
  return withoutPrefix.length > 14 ? `${withoutPrefix.slice(0, 12)}…` : withoutPrefix
}

function containsRect(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x - TOLERANCE &&
    inner.y >= outer.y - TOLERANCE &&
    inner.x + inner.width <= outer.x + outer.width + TOLERANCE &&
    inner.y + inner.height <= outer.y + outer.height + TOLERANCE
}

function neighboursOf(
  subject: Rect,
  occupants: ReadonlyArray<{ id: string; rect: Rect }>,
  gap: number,
  onlyConflicting: boolean,
): CollisionNeighbour[] {
  return occupants
    .map(occupant => ({
      nodeId: occupant.id,
      separation: round(separationBetween(subject, occupant.rect).min),
      required: round(gap),
    }))
    .filter(neighbour => !onlyConflicting || neighbour.separation < gap - TOLERANCE)
    .sort((left, right) => left.separation - right.separation)
    .slice(0, 6)
}

/**
 * Live geometry for the whole scene plus, when a drag is in flight, the
 * engine's own decision about where it would land.
 *
 * Pure and synchronous: it reads nodes and returns rects. Nothing here mutates
 * the scene, so it is safe to call on every animation frame of a drag — and it
 * must be called that often, because a box that lags the gesture by a frame is
 * a box that answers the wrong question.
 */
export function buildCollisionModel({
  layer,
  nodes,
  absolutePositions,
  draggedNodeId = null,
  targetNodeId = null,
  editableNodeIds = null,
}: CollisionModelInput): CollisionModel {
  const boxes: CollisionBox[] = []
  const issues: CollisionIssue[] = []
  const byId = new Map(nodes.map(node => [node.id, node]))

  const rectById = new Map<string, Rect>()
  for (const node of nodes) {
    const absolute = absolutePositions.get(node.id)
    if (!absolute) {
      issues.push({
        code: 'missing-absolute',
        severity: 'error',
        message: `${shortId(node.id)} has no absolute position; collision fell back to its parent-local one.`,
        nodeIds: [node.id],
      })
    }
    rectById.set(node.id, nodeWorldRect(node, absolute ?? node.position))
  }

  // ── Spacing ───────────────────────────────────────────────────────────────
  // Two numbers, and only one of them is a rule.
  //
  // The PACKING gap is a property of the container: roots are spread by one
  // value, a frame's occupants by another, scaled by how much that frame
  // compresses its contents. It decides what Axiom's own arrangements look
  // like, and where a hand-dropped node is offered a resting spot when it has
  // to move at all. Nothing is ever rejected for violating it.
  //
  // The CLEARANCE is flat, small and identical everywhere. It is the only
  // distance a placement can fail, so it is the one drawn as a halo and the one
  // the invariants below judge against. Drawing the packing gap as though it
  // repelled things is what made the canvas look like a minefield.
  const packingByParent = new Map<string | null, WorldGap>()
  const parentIds = new Set<string | null>([null, ...nodes.map(node => node.parentId ?? null)])
  for (const parentId of parentIds) {
    packingByParent.set(parentId, packingGapWithin(parentId ? byId.get(parentId) ?? null : null))
  }
  const clearance = dropClearance()

  const childrenByParent = new Map<string | null, Node[]>()
  for (const node of nodes) {
    const parentId = node.parentId ?? null
    const siblings = childrenByParent.get(parentId)
    if (siblings) siblings.push(node)
    else childrenByParent.set(parentId, [node])
  }

  // ── Boxes ─────────────────────────────────────────────────────────────────
  let frameCount = 0
  for (const node of nodes) {
    const rect = rectById.get(node.id)!
    boxes.push({
      key: `node:${node.id}`,
      kind: 'node',
      rect,
      label: `${shortId(node.id)} ${round(rect.width)}×${round(rect.height)}`,
      nodeId: node.id,
      gap: null,
    })
    boxes.push({
      key: `clearance:${node.id}`,
      kind: 'clearance',
      rect: clearanceRect(rect, clearance.gap),
      label: `±${round(clearance.gap)}`,
      nodeId: node.id,
      gap: clearance.gap,
    })
    if (isFrameNode(node)) {
      frameCount++
      const content = frameWorldContentRect(node, { x: rect.x, y: rect.y })
      boxes.push({
        key: `content:${node.id}`,
        kind: 'content',
        rect: content,
        label: `interior ${round(content.width)}×${round(content.height)}`,
        nodeId: node.id,
        gap: null,
      })
    }
  }

  // ── Standing invariants ───────────────────────────────────────────────────
  for (const node of nodes) {
    const disagreement = nodeSizeDisagreement(node)
    if (disagreement.width > TOLERANCE || disagreement.height > TOLERANCE) {
      issues.push({
        code: 'size-disagreement',
        severity: 'warn',
        message: `${shortId(node.id)} measures ${round(disagreement.width)}×${round(disagreement.height)} away from its requested size — collision and containment are using different rectangles.`,
        nodeIds: [node.id],
      })
    }
  }

  for (const [parentId, children] of childrenByParent) {
    const parent = parentId ? byId.get(parentId) ?? null : null
    const parentRect = parentId ? rectById.get(parentId) : undefined
    const content = parent && parentRect
      ? frameWorldContentRect(parent, { x: parentRect.x, y: parentRect.y })
      : null

    for (const child of children) {
      const rect = rectById.get(child.id)!
      if (content && !containsRect(content, rect)) {
        issues.push({
          code: 'escapes-parent',
          severity: 'error',
          message: `${shortId(child.id)} extends outside the usable interior of ${shortId(parentId!)}.`,
          nodeIds: [child.id, parentId!],
        })
      }
      if (content && (rect.width > content.width + TOLERANCE || rect.height > content.height + TOLERANCE)) {
        issues.push({
          code: 'frame-too-small',
          severity: 'error',
          message: `${shortId(parentId!)} has a ${round(content.width)}×${round(content.height)} interior but holds a ${round(rect.width)}×${round(rect.height)} node — no placement can satisfy it.`,
          nodeIds: [child.id, parentId!],
        })
      }
    }

    // Judged against the clearance, never against the packing gap. Two nodes
    // sitting closer than Axiom would have arranged them is not a defect — it
    // is a person having placed them there.
    for (let i = 0; i < children.length; i++) {
      for (let j = i + 1; j < children.length; j++) {
        const a = rectById.get(children[i].id)!
        const b = rectById.get(children[j].id)!
        if (!conflictsAt(a, b, clearance.gap - TOLERANCE)) continue
        const separation = round(separationBetween(a, b).min)
        issues.push({
          code: 'sibling-conflict',
          severity: separation < 0 ? 'error' : 'warn',
          message: separation < 0
            ? `${shortId(children[i].id)} and ${shortId(children[j].id)} overlap by ${round(-separation)}.`
            : `${shortId(children[i].id)} and ${shortId(children[j].id)} sit ${separation} apart — closer than the ${round(clearance.gap)} their borders need.`,
          nodeIds: [children[i].id, children[j].id],
        })
      }
    }
  }

  // ── Live drag ─────────────────────────────────────────────────────────────
  const drag = draggedNodeId
    ? describeDrag({
        nodes,
        byId,
        rectById,
        absolutePositions,
        draggedNodeId,
        targetNodeId,
        editableNodeIds,
      })
    : null

  if (drag) {
    boxes.push({
      key: 'drag:incoming',
      kind: 'incoming',
      rect: drag.incoming,
      label: `held ${round(drag.incoming.width)}×${round(drag.incoming.height)}`,
      nodeId: drag.draggedNodeId,
      gap: null,
    })
    if (drag.destination) {
      boxes.push({
        key: 'drag:destination',
        kind: 'destination',
        rect: drag.destination,
        label: `drop into ${shortId(drag.targetNodeId!)}`,
        nodeId: drag.targetNodeId,
        gap: null,
      })
    }
    if (drag.landing) {
      boxes.push({
        key: 'drag:landing',
        kind: 'landing',
        rect: drag.landing,
        label: `${drag.resolution}${drag.repelDistance > TOLERANCE ? ` · pushed ${round(drag.repelDistance)}` : ''}`,
        nodeId: drag.draggedNodeId,
        gap: null,
      })
    }
    for (const blocker of drag.blockers) {
      const rect = rectById.get(blocker.nodeId)
      if (!rect) continue
      boxes.push({
        key: `drag:blocker:${blocker.nodeId}`,
        kind: 'blocker',
        rect: clearanceRect(rect, drag.clearance.gap),
        label: `blocks · ${blocker.separation} of ${blocker.required}`,
        nodeId: blocker.nodeId,
        gap: drag.clearance.gap,
      })
    }
  }

  const gaps = [...packingByParent.entries()]
    .map(([frameId, gap]) => ({
      frameId,
      label: frameId ? shortId(frameId) : 'root plane',
      gap,
    }))
    .sort((left, right) => (left.frameId === null ? -1 : right.frameId === null ? 1 : left.label.localeCompare(right.label)))

  return {
    layer,
    boxes,
    issues,
    drag,
    clearance,
    gaps,
    nodeCount: nodes.length,
    frameCount,
    editableCount: editableNodeIds ? editableNodeIds.size : null,
  }
}

function describeDrag({
  nodes,
  byId,
  rectById,
  absolutePositions,
  draggedNodeId,
  targetNodeId,
  editableNodeIds,
}: {
  nodes: Node[]
  byId: ReadonlyMap<string, Node>
  rectById: ReadonlyMap<string, Rect>
  absolutePositions: ReadonlyMap<string, Point>
  draggedNodeId: string
  targetNodeId: string | null
  editableNodeIds: ReadonlySet<string> | null
}): CollisionDragReport | null {
  if (!byId.has(draggedNodeId)) return null
  // A layer that restricts editing restricts the gesture the same way the drop
  // planner does, so the reported group is the group that would actually move.
  if (editableNodeIds && !editableNodeIds.has(draggedNodeId)) return null
  const selectedIds = nodes
    .filter(node => node.selected && (!editableNodeIds || editableNodeIds.has(node.id)))
    .map(node => node.id)
  if (!selectedIds.includes(draggedNodeId)) selectedIds.push(draggedNodeId)

  const frame = buildDropFrame({
    allNodes: nodes,
    selectedIds,
    targetNodeId,
    absolutePositions,
    allowInteriorCompression: true,
  })
  if (!frame.incomingBounds) return null

  const parentById = new Map(nodes.map(node => [node.id, node.parentId ?? null]))
  const movingNodeIds = highestSelectedRoots(selectedIds, parentById)
  const clearance = dropClearance()
  const packingGap = packingGapWithin(frame.target)
  const occupants = frame.placementRects
    .filter(rect => !frame.incomingIds.has(rect.id))
    .map(rect => ({ id: rect.id, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }))

  const landing = (() => {
    const rect = frame.placementRects.find(candidate => candidate.id === draggedNodeId)
    if (!rect) return null
    const position = worldPositionFor(rect, frame)
    return {
      x: position.x,
      y: position.y,
      width: rect.width * frame.fit,
      height: rect.height * frame.fit,
    }
  })()
  const held = rectById.get(draggedNodeId) ?? frame.incomingBounds

  return {
    draggedNodeId,
    movingNodeIds,
    targetNodeId: frame.target?.id ?? null,
    destination: frame.destination,
    incoming: frame.incomingBounds,
    landing,
    repelDistance: landing ? Math.hypot(landing.x - held.x, landing.y - held.y) : 0,
    resolution: frame.resolution,
    changesParent: frame.changesParent,
    clearance,
    packingGap,
    blockers: neighboursOf(frame.incomingBounds, occupants, clearance.gap, true),
    landingNeighbours: landing ? neighboursOf(landing, occupants, clearance.gap, false) : [],
    landingApproximate: frame.resolution === 'compress',
  }
}

/**
 * One-line summaries for a console dump. Handy when the visual overlay itself
 * is the thing under suspicion.
 */
export function summarizeCollisionModel(model: CollisionModel): string[] {
  const lines = [
    `layer=${model.layer} nodes=${model.nodeCount} frames=${model.frameCount} editable=${model.editableCount ?? 'all'}`,
    `clearance (enforced): ${round(model.clearance.gap)} world — ${model.clearance.source}`,
    ...model.gaps.map(entry =>
      `packing gap ${entry.label}: ${round(entry.gap.gap)} world (${entry.gap.source} ${entry.gap.authored} × contentScale ${round(entry.gap.contentScale)})`),
  ]
  if (model.drag) {
    const drag = model.drag
    lines.push(
      `drag ${shortId(drag.draggedNodeId)} → ${drag.targetNodeId ? shortId(drag.targetNodeId) : 'root plane'}` +
      ` · ${drag.resolution} · pushed ${round(drag.repelDistance)} · clearance ${round(drag.clearance.gap)}`,
    )
    for (const blocker of drag.blockers) {
      lines.push(`  blocked by ${shortId(blocker.nodeId)}: ${blocker.separation} apart, needs ${blocker.required}`)
    }
  }
  for (const issue of model.issues) lines.push(`${issue.severity}: ${issue.message}`)
  return lines
}

/**
 * Absolute positions derived from the node tree alone.
 *
 * React Flow's internal store is the authority during a drag — it is one frame
 * fresher — so this is the fallback for callers that hold only the node array,
 * and the path tests use. `position` is already in rendered pixels relative to
 * the parent's origin (the projection multiplies canonical coordinates by the
 * parent's content scale before handing them to React Flow), so accumulating
 * it is plain addition, exactly as React Flow does it.
 */
export function absolutePositionsFromTree(nodes: readonly Node[]): Map<string, Point> {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const resolved = new Map<string, Point>()
  const resolve = (node: Node, seen: Set<string>): Point => {
    const cached = resolved.get(node.id)
    if (cached) return cached
    if (seen.has(node.id)) return node.position
    seen.add(node.id)
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    const base = parent ? resolve(parent, seen) : { x: 0, y: 0 }
    const point = { x: base.x + node.position.x, y: base.y + node.position.y }
    resolved.set(node.id, point)
    return point
  }
  for (const node of nodes) resolve(node, new Set())
  return resolved
}

/** Bounding box of every drawn box, for a "frame the debug view" action. */
export function collisionModelBounds(model: CollisionModel): Rect | null {
  return boundsOf(model.boxes.map(box => box.rect))
}
