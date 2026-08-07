import type { Node } from '@xyflow/react'
import type { FloorLayout, FloorNodeType } from '../../shared/types'
import {
  boundsOf,
  DROP_CLEARANCE,
  FRAME_ITEM_GAP,
  fitReferenceFrame,
  highestSelectedRoots,
  localScaleAfterWorldFit,
  transformReferencePoint,
  type Point,
  type Rect,
  type ReferenceFrameTransform,
} from './frameGeometry.ts'
import {
  planInteriorCompression,
  type InteriorCompressionPlan,
} from './interiorCompression.ts'
import {
  dropClearance,
  frameOwnContentRect,
  frameWorldContentRect,
  nodeContentScale,
  nodeInteriorScale,
  nodeWorldRect,
  nodeWorldScale,
  packingGapWithin,
  positiveFinite,
} from './nodeGeometry.ts'
import { packFrame, placeNearest } from './packing.ts'
import { type FloorLayoutWrite } from './resizePersistence.ts'

export interface DropFrameInput {
  allNodes: Node[]
  selectedIds: string[]
  targetNodeId: string | null
  absolutePositions: ReadonlyMap<string, Point>
  /**
   * Enables case 3. Both the Floor and Sheets use the same compression model.
   */
  allowInteriorCompression?: boolean
}

/**
 * Which placement strategy produced the landing spot, in escalating order of
 * how much of the existing arrangement it disturbs.
 *
 *   direct     — landed where it was released (clamped inside the frame).
 *   slide      — moved to the nearest free slot inside a frame.
 *   root-slide — same search among top-level frames, at FRAME_ROOT_GAP.
 *   repack     — same-parent move with no free slot: siblings were rearranged.
 *   compress   — the frame shrank its interior to make room.
 *   group-fit  — no interior lever available: the whole group was scaled in.
 *   blocked    — nothing worked; the node keeps its released position.
 */
export type DropResolution =
  | 'direct' | 'slide' | 'root-slide' | 'repack' | 'compress' | 'group-fit' | 'blocked'

export interface DropFrame {
  resolution: DropResolution
  /** True when the drop moves the node into a different parent. */
  changesParent: boolean
  /**
   * The spacing Axiom would CHOOSE inside this destination, in absolute world
   * units. A preference used by the repack fallback; it never rejects a drop.
   */
  worldGap: number
  /** The only spacing this drop had to satisfy, in absolute world units. */
  clearance: number
  roots: Node[]
  layoutRoots: Node[]
  target: Node | null
  targetAbsolute: Point
  targetScale: number
  placementRects: Array<Rect & { id: string }>
  incomingIds: Set<string>
  /** Absolute world bounds of the incoming group at the moment it was dropped. */
  incomingBounds: Rect | null
  incomingOffset: Point | null
  frameTransform: ReferenceFrameTransform | null
  fit: number
  groupBounds: Rect | null
  /** Absolute content box of the drop target, header inset already applied. */
  destination: Rect | null
  /** World scale the target's existing children already share, if any. */
  siblingWorldScale: number | null
  /** World scale of the target's CONTENT space (its own scale x interiorScale). */
  targetContentScale: number
  /** Case 3: how much the target must compress its interior to fit the drop. */
  compression: InteriorCompressionPlan | null
  /** Full sibling repack used only when an in-place move has no free slot. */
  repackedPositions: ReadonlyMap<string, Point> | null
}

interface CanvasDropPlanInput {
  workspaceId: string | null
  draggedNodeId: string
  targetNodeId: string | null
  allNodes: Node[]
  absolutePositions: ReadonlyMap<string, Point>
  systemIds: Set<string>
  fileIds: Set<string>
  infraIds: Set<string>
  floorLayouts: FloorLayout[]
  /**
   * Limits which selected nodes may participate in the gesture without
   * removing the rest of the projected scene from collision detection.
   */
  editableNodeIds?: ReadonlySet<string>
  now?: number
}

export interface CanvasDropPersistencePlan {
  selectedIds: string[]
  updates: FloorLayoutWrite[]
  changedKeys: Set<string>
  previousLayouts: FloorLayout[]
  optimisticLayouts: FloorLayout[]
  /**
   * The same rows, but describing the node exactly where the pointer released
   * it: reparented, still at its old size, nothing corrected and nothing
   * compressed.
   *
   * A drop is committed in two phases so every correction is something the eye
   * can follow. Applying the reparent and the correction in one commit gives a
   * CSS transition no "before" state to interpolate from — the node simply
   * appears at its corrected spot. Landing here first, then animating to
   * `optimisticLayouts`, makes the edge push, the slide off a sibling, the
   * size-parity change and the interior compression all visible movements.
   */
  arrivalLayouts: FloorLayout[]
}

function nodeTypeFor(id: string, systemIds: Set<string>, fileIds: Set<string>): FloorNodeType {
  if (systemIds.has(id)) return 'system'
  if (fileIds.has(id)) return 'file'
  return 'infra'
}

/**
 * The complete geometric state of one drop, exactly as the planner sees it.
 *
 * Exported so a debug view can render the engine's own reasoning rather than
 * reimplementing it. Anything drawn on screen from this object is, by
 * construction, what actually decided where the node landed.
 */
export function buildDropFrame({
  allNodes,
  selectedIds,
  targetNodeId,
  absolutePositions,
  allowInteriorCompression = false,
}: DropFrameInput): DropFrame {
  const parentById = new Map(allNodes.map(node => [node.id, node.parentId ?? null]))
  const roots = highestSelectedRoots(selectedIds, parentById)
    .map(id => allNodes.find(node => node.id === id))
    .filter((node): node is Node => !!node)
  const target = targetNodeId ? allNodes.find(node => node.id === targetNodeId) ?? null : null
  const changesParent = !!target && roots.some(root => root.parentId !== target.id)
  const incomingIds = new Set(roots.map(root => root.id))
  // Every drop plans against its complete sibling set. Previously residents
  // were only present for a reparent, so moving a node within its existing
  // frame (or among root nodes) bypassed collision handling altogether.
  const destinationParentId = target?.id ?? null
  const layoutRoots = [
    ...allNodes.filter(node =>
      (node.parentId ?? null) === destinationParentId &&
      !incomingIds.has(node.id) &&
      node.id !== target?.id),
    ...roots,
  ]
  const placementRects = layoutRoots.map(root => ({
    id: root.id,
    ...nodeWorldRect(root, absolutePositions.get(root.id) ?? root.position),
  }))
  const targetAbsolute = target ? absolutePositions.get(target.id) ?? { x: 0, y: 0 } : { x: 0, y: 0 }
  const targetScale = target ? nodeWorldScale(target) : 1
  // Children live in the target's CONTENT space. It differs from the target's
  // own world scale exactly when the target already compresses its interior.
  const targetContentScale = target ? nodeContentScale(target) : 1
  const targetInteriorScale = target ? nodeInteriorScale(target) : 1
  // Size parity: a node arriving from elsewhere carries its own world scale,
  // so applying one fit factor to every node left the newcomer a different
  // size from the siblings it just joined. Adopt the scale they already use.
  const incomingVisualType = roots.length > 0 && roots.every(root => root.type === roots[0].type)
    ? roots[0].type
    : null
  const siblingWorldScales = allNodes
    .filter(node =>
      target &&
      node.parentId === target.id &&
      !incomingIds.has(node.id) &&
      incomingVisualType !== null &&
      node.type === incomingVisualType)
    .map(node => positiveFinite((node.data as Record<string, unknown>).worldScale, 0))
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
  const siblingWorldScale = siblingWorldScales.length > 0
    ? siblingWorldScales[Math.floor(siblingWorldScales.length / 2)]
    : null
  // Header-aware, exactly like the resize clamp and the resize minimum. Using
  // `contentRect`'s flat defaults here made a drop and a resize disagree about
  // where a frame's usable space begins.
  const destination = target ? frameWorldContentRect(target, targetAbsolute) : null
  const groupBounds = boundsOf(placementRects)
  const incomingBounds = boundsOf(placementRects.filter(rect => incomingIds.has(rect.id)))
  const occupiedRects = placementRects.filter(rect => !incomingIds.has(rect.id))
  // Placement is tried in order of how much it disturbs what is already there.
  //   1. Land where it was dropped, nudged minimally inside the frame if it
  //      overhangs an edge.
  //   2. Slide to the nearest free slot, seeded from the drop point. Existing
  //      children are immovable obstacles; nothing else changes.
  //   3. Only then compress the frame's interior.
  //
  // Two spacings, and the difference between them is the difference between a
  // preference and a law.
  //
  // `clearance` is the only distance a hand-placed drop can FAIL. It is small,
  // flat and identical at every depth — just enough that two borders never
  // share a line. Steps 1, 2 and 3 all measure against it and nothing else.
  //
  // `worldGap` is how far apart Axiom LIKES to leave things when IT is the one
  // arranging them. Below, that is the repack fallback alone. Letting it reach
  // any step that judges a human's drop is what made a node unable to approach
  // a system: the release point was legal — not overlapping, inside the frame —
  // and got thrown a hundred units away for sitting inside a tidiness margin,
  // because every alternative the search offered was a full gap clear of
  // everything.
  //
  // These rects are ABSOLUTE WORLD geometry, while FRAME_ITEM_GAP is authored
  // in canonical units, so the packing gap converts through the content scale.
  // Without this a frame nested at half scale left twice the gap.
  const worldGap = packingGapWithin(target).gap
  const clearance = dropClearance().gap
  const collidesAt = (position: Point, size: Rect): boolean => occupiedRects.some(rect =>
    position.x < rect.x + rect.width + clearance &&
    position.x + size.width + clearance > rect.x &&
    position.y < rect.y + rect.height + clearance &&
    position.y + size.height + clearance > rect.y)

  // Step 1 is a plain minimal clamp. It used to be a "wall-directed" search
  // that pushed the node to the MIDPOINT of the largest free run — so a node
  // dropped a few pixels above a frame's tab flew hundreds of units down the
  // frame, while every other path nudged by the smallest amount that worked.
  // A drop that already sits clear keeps its exact position, as before.
  const directOffset = target && destination && incomingBounds
    ? (() => {
        const clamped = containPointWithin(incomingBounds, incomingBounds, destination)
        return collidesAt(clamped, incomingBounds)
          ? null
          : { x: clamped.x - incomingBounds.x, y: clamped.y - incomingBounds.y }
      })()
    : null
  const slidOffset = !directOffset && target && destination && incomingBounds
    ? slideIncomingIntoFreeSlot(incomingBounds, destination, occupiedRects, clearance)
    : null
  const rootOffset = !target && incomingBounds
    ? slideIncomingIntoFreeSlot(incomingBounds, null, occupiedRects, clearance)
    : null
  const incomingOffset = directOffset ?? slidOffset ?? rootOffset

  // A same-parent move cannot add pressure to the frame: the dragged nodes
  // were already part of its contents. If their requested slot and every
  // nearest free slot are blocked, rebuild the complete sibling arrangement
  // with the same deterministic packer used by a fresh live Canvas.
  const repackedPositions = target && !changesParent && !incomingOffset && destination
    ? (() => {
        const packed = packFrame(
          placementRects.map(rect => ({ id: rect.id, width: rect.width, height: rect.height })),
          {
            baseGap: worldGap,
            aspect: destination.width / Math.max(1, destination.height),
          },
        )
        if (packed.width > destination.width || packed.height > destination.height) return null
        return new Map([...packed.positions].map(([id, position]) => [
          id,
          { x: destination.x + position.x, y: destination.y + position.y },
        ]))
      })()
    : null

  // Case 3. Only reached when neither the drop point nor any free slot works.
  // The whole computation happens in the target's CONTENT space, because that
  // is the space the children are stored in and the space compression acts on.
  const needsCompression = changesParent && !!target && !incomingOffset && !!destination && !!incomingBounds
  const compression = needsCompression && allowInteriorCompression && target && destination && incomingBounds
    ? planInteriorCompression(
        {
          // Content box in the target's OWN canonical space.
          ownContent: frameOwnContentRect(target),
          occupied: occupiedRects.map(rect => toContentSpace(rect, targetAbsolute, targetContentScale)),
          incoming: incomingSizeAtSiblingScale(incomingBounds, roots, siblingWorldScale, targetContentScale),
          origin: toContentSpace(incomingBounds, targetAbsolute, targetContentScale),
          interiorScale: targetInteriorScale,
          // The legibility floor binds on the SMALLEST child, so a frame that
          // already holds tiny nodes gets little further headroom.
          minChildWorldScale: smallestChildWorldScale(allNodes, target.id, incomingIds, siblingWorldScale),
          // Authored in world units, so it converts INTO the container's
          // content space, which is the space this whole plan is computed in.
          clearance: clearance / Math.max(0.0001, targetContentScale),
        },
        slideIncomingIntoFreeSlot,
      )
    : null

  // The sheet layer has no interior lever, so it keeps the group transform.
  const frameTransform = needsCompression && !allowInteriorCompression && groupBounds && destination && incomingBounds
    ? fitReferenceFrame(groupBounds, destination, incomingBounds)
    : null

  // Which of the escalating placement strategies actually decided the landing
  // spot. The cases are mutually exclusive by construction — compression needs
  // a parent change, a repack needs the absence of one — so this reads the
  // outcome rather than re-deciding it.
  const resolution: DropResolution =
    compression ? 'compress'
    : repackedPositions ? 'repack'
    : frameTransform ? 'group-fit'
    : directOffset ? 'direct'
    : slidOffset ? 'slide'
    : rootOffset ? 'root-slide'
    : 'blocked'

  return {
    resolution,
    changesParent,
    worldGap,
    clearance,
    roots,
    layoutRoots,
    target,
    targetAbsolute,
    targetScale,
    placementRects,
    incomingIds,
    incomingBounds,
    incomingOffset,
    frameTransform,
    fit: frameTransform?.scale ?? 1,
    groupBounds,
    destination,
    siblingWorldScale,
    targetContentScale,
    compression,
    repackedPositions,
  }
}

/** Absolute world rect -> the container's content coordinate space. */
function toContentSpace(rect: Rect, containerAbsolute: Point, contentScale: number): Rect {
  const scale = Math.max(0.0001, contentScale)
  return {
    x: (rect.x - containerAbsolute.x) / scale,
    y: (rect.y - containerAbsolute.y) / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  }
}

/**
 * The newcomer adopts its new siblings' scale rather than keeping its own, so
 * the size compression has to make room for is the size it will actually be.
 */
function incomingSizeAtSiblingScale(
  incomingBounds: Rect,
  roots: readonly Node[],
  siblingWorldScale: number | null,
  contentScale: number,
): { width: number; height: number } {
  const scale = Math.max(0.0001, contentScale)
  if (siblingWorldScale === null || roots.length === 0) {
    return { width: incomingBounds.width / scale, height: incomingBounds.height / scale }
  }
  const ownWorldScale = positiveFinite((roots[0].data as Record<string, unknown>).worldScale)
  const resized = siblingWorldScale / ownWorldScale
  return {
    width: (incomingBounds.width * resized) / scale,
    height: (incomingBounds.height * resized) / scale,
  }
}

/**
 * The smallest world scale present in the frame once the drop lands. The
 * legibility floor is measured against this so compression compounds honestly
 * through nesting instead of giving each level a fresh budget.
 */
function smallestChildWorldScale(
  allNodes: readonly Node[],
  targetId: string,
  incomingIds: ReadonlySet<string>,
  siblingWorldScale: number | null,
): number {
  const scales = allNodes
    .filter(node => node.parentId === targetId && !incomingIds.has(node.id))
    .map(node => positiveFinite((node.data as Record<string, unknown>).worldScale))
    .filter(value => Number.isFinite(value) && value > 0)
  if (siblingWorldScale !== null && siblingWorldScale > 0) scales.push(siblingWorldScale)
  return scales.length > 0 ? Math.min(...scales) : 1
}

/**
 * Clamps a landing position so the whole rect sits inside `bounds`. A rect too
 * large for its frame is pinned to the frame origin rather than centred, so it
 * overflows predictably from one corner instead of on every side.
 */
export function containPointWithin(
  point: Point,
  size: { width: number; height: number },
  bounds: Rect | null,
): Point {
  if (!bounds) return point
  const maxX = bounds.x + Math.max(0, bounds.width - size.width)
  const maxY = bounds.y + Math.max(0, bounds.height - size.height)
  return {
    x: Math.min(Math.max(point.x, bounds.x), maxX),
    y: Math.min(Math.max(point.y, bounds.y), maxY),
  }
}

/**
 * Nearest free slot for the incoming group, searched from where it was
 * dropped. Existing children are fixed obstacles, so this never disturbs an
 * arrangement the user has already set up — it only decides where the newcomer
 * lands. Returns the translation to apply, or null if the frame has no room.
 *
 * `clearance` is the ONLY spacing this obeys, and the packing gaps are
 * deliberately not passed in. A drop that already sits clear translates by
 * zero, because the release point is the first candidate tried and nothing
 * rejects it; a drop that genuinely conflicts moves the smallest distance that
 * separates the two borders, not to the distance Axiom would have chosen.
 */
export function slideIncomingIntoFreeSlot(
  incoming: Rect,
  destination: Rect | null,
  occupied: readonly Rect[],
  clearance = DROP_CLEARANCE,
): Point | null {
  const placed = placeNearest(
    { id: '__incoming__', width: incoming.width, height: incoming.height },
    occupied,
    { baseGap: clearance, bounds: destination, preferred: { x: incoming.x, y: incoming.y } },
  )
  if (!placed) return null
  return { x: placed.x - incoming.x, y: placed.y - incoming.y }
}

export function worldPositionFor(rect: Rect & { id: string }, frame: DropFrame): Point {
  const repacked = frame.repackedPositions?.get(rect.id)
  if (repacked) return repacked
  if (frame.frameTransform) return transformReferencePoint(rect, frame.frameTransform)
  if (frame.incomingIds.has(rect.id) && frame.incomingOffset) {
    return { x: rect.x + frame.incomingOffset.x, y: rect.y + frame.incomingOffset.y }
  }
  return { x: rect.x, y: rect.y }
}

/**
 * Where an incoming node lands, in the container's content space, once the
 * interior has been compressed. Compression does not move the newcomer's
 * neighbours, so its landing point is simply the planned slot plus whatever
 * offset it had from the group's own bounds when it was dropped.
 */
function compressedLocalPosition(rect: Rect, frame: DropFrame): Point {
  const plan = frame.compression!
  const bounds = frame.incomingBounds ?? rect
  const scale = Math.max(0.0001, frame.targetContentScale)
  const offsetX = (rect.x - bounds.x) / scale
  const offsetY = (rect.y - bounds.y) / scale
  return { x: plan.placement.x + offsetX, y: plan.placement.y + offsetY }
}

/**
 * The container's own row, rewritten with a new interior scale and nothing
 * else. Reusing its persisted geometry verbatim is deliberate — a compression
 * that altered the container's position or size would defeat the whole design.
 */
function containerCompressionWrite(
  target: Node,
  interiorScale: number,
  floorLayouts: FloorLayout[],
  systemIds: Set<string>,
  fileIds: Set<string>,
  infraIds: Set<string>,
): FloorLayoutWrite | null {
  const nodeType = nodeTypeFor(target.id, systemIds, fileIds)
  const previous = floorLayouts.find(layout => layout.nodeId === target.id && layout.nodeType === nodeType)
  if (previous) {
    const parentNodeType: FloorLayoutWrite['parentNodeType'] = previous.parentNodeId
      ? (infraIds.has(previous.parentNodeId) ? 'infra' : 'system')
      : null
    return {
      nodeId: previous.nodeId,
      nodeType: previous.nodeType,
      parentNodeId: previous.parentNodeId,
      parentNodeType,
      containmentKind: previous.containmentKind,
      positionX: previous.positionX,
      positionY: previous.positionY,
      width: previous.width,
      height: previous.height,
      scale: previous.scale,
      interiorScale,
    }
  }

  // A container with no persisted row yet still has to receive the compression:
  // the newcomer's position was already computed in the compressed space, so
  // skipping this write would place it against a frame that never shrank.
  // Reconstruct the row from the projected geometry it is currently rendering.
  const data = target.data as Record<string, unknown>
  const ownScale = positiveFinite(data.frameScale)
  const worldScale = positiveFinite(data.worldScale, ownScale)
  const parentContentScale = target.parentId ? worldScale / Math.max(0.0001, ownScale) : 1
  const parentNodeType: FloorLayoutWrite['parentNodeType'] = target.parentId
    ? (infraIds.has(target.parentId) ? 'infra' : 'system')
    : null
  return {
    nodeId: target.id,
    nodeType,
    parentNodeId: target.parentId ?? null,
    parentNodeType,
    containmentKind: parentNodeType === 'infra' ? 'hosted_by' : parentNodeType === 'system' ? 'part_of' : 'root',
    positionX: target.position.x / Math.max(0.0001, parentContentScale),
    positionY: target.position.y / Math.max(0.0001, parentContentScale),
    width: positiveFinite(target.style?.width ?? target.measured?.width, 1) / worldScale,
    height: positiveFinite(target.style?.height ?? target.measured?.height, 1) / worldScale,
    scale: ownScale,
    interiorScale,
  }
}

function selectedIdsForDrop(nodes: Node[], draggedNodeId: string, eligible: (node: Node) => boolean): string[] {
  const selected = nodes.filter(node => node.selected && eligible(node)).map(node => node.id)
  if (!selected.includes(draggedNodeId)) selected.push(draggedNodeId)
  return selected
}

export function planCanvasDrop({
  workspaceId,
  draggedNodeId,
  targetNodeId,
  allNodes,
  absolutePositions,
  systemIds,
  fileIds,
  infraIds,
  floorLayouts,
  editableNodeIds,
  now = Date.now(),
}: CanvasDropPlanInput): CanvasDropPersistencePlan {
  if (editableNodeIds && !editableNodeIds.has(draggedNodeId)) {
    return {
      selectedIds: [],
      updates: [],
      changedKeys: new Set(),
      previousLayouts: [],
      optimisticLayouts: [],
      arrivalLayouts: [],
    }
  }
  const selectedIds = selectedIdsForDrop(
    allNodes,
    draggedNodeId,
    node => !editableNodeIds || editableNodeIds.has(node.id),
  )
  const frame = buildDropFrame({
    allNodes,
    selectedIds,
    targetNodeId,
    absolutePositions,
    allowInteriorCompression: true,
  })
  // Normal placement and compression leave residents untouched. The one
  // exception is the deterministic same-parent fallback above: it is a real
  // repack, so every sibling whose canonical position may change is written.
  const writtenRoots = frame.repackedPositions ? frame.layoutRoots : frame.roots
  // Where each node physically was when the pointer came up, expressed in its
  // NEW parent's coordinate space. Phase one of the drop puts it here, so the
  // reparent itself is visually a no-op and every correction after it animates.
  const arrivalById = new Map<string, { x: number; y: number; scale: number }>()
  for (const root of writtenRoots) {
    const rect = frame.placementRects.find(candidate => candidate.id === root.id)!
    const ownWorldScale = positiveFinite((root.data as Record<string, unknown>).worldScale)
    arrivalById.set(root.id, frame.target
      ? {
          x: (rect.x - frame.targetAbsolute.x) / frame.targetContentScale,
          y: (rect.y - frame.targetAbsolute.y) / frame.targetContentScale,
          // Keep its current rendered size on arrival; the size-parity change
          // is one of the things that should be seen happening.
          scale: ownWorldScale / Math.max(0.0001, frame.targetContentScale),
        }
      : { x: rect.x, y: rect.y, scale: ownWorldScale })
  }
  const updates = workspaceId && frame.groupBounds
    ? writtenRoots.map(root => {
        const nodeType = nodeTypeFor(root.id, systemIds, fileIds)
        const previous = floorLayouts.find(layout => layout.nodeId === root.id && layout.nodeType === nodeType)
        const rect = frame.placementRects.find(candidate => candidate.id === root.id)!
        // The cursor decides which frame you dropped into; it does not
        // guarantee the node fits there. Nudge the landing rect fully inside
        // the frame so an edge can never hang outside its own parent.
        const nextWorld = containPointWithin(
          worldPositionFor(rect, frame),
          { width: rect.width * frame.fit, height: rect.height * frame.fit },
          frame.destination,
        )
        const local = frame.compression
          ? compressedLocalPosition(rect, frame)
          : frame.target
            ? {
                x: (nextWorld.x - frame.targetAbsolute.x) / frame.targetContentScale,
                y: (nextWorld.y - frame.targetAbsolute.y) / frame.targetContentScale,
              }
            : nextWorld
        const oldWorldScale = positiveFinite(
          (root.data as Record<string, unknown>).worldScale,
          previous?.scale ?? 1,
        )
        const materializedWidth = positiveFinite(root.style?.width, rect.width) / oldWorldScale
        const materializedHeight = positiveFinite(root.style?.height, rect.height) / oldWorldScale
        const parentNodeType: FloorLayoutWrite['parentNodeType'] = frame.target
          ? (infraIds.has(frame.target.id) ? 'infra' : 'system')
          : null
        return {
          nodeId: root.id,
          nodeType,
          parentNodeId: frame.target?.id ?? null,
          parentNodeType,
          containmentKind: parentNodeType === 'infra' ? 'hosted_by' as const : parentNodeType === 'system' ? 'part_of' as const : 'root' as const,
          positionX: local.x,
          positionY: local.y,
          width: previous?.width ?? materializedWidth,
          height: previous?.height ?? materializedHeight,
          // Local scale is measured against the parent's CONTENT scale, so it
          // is invariant under compression: the newcomer and its siblings both
          // ride the same space and end up the same size, which is the whole
          // point of adopting the siblings' scale rather than keeping its own.
          scale: frame.siblingWorldScale !== null && frame.incomingIds.has(root.id)
            ? frame.siblingWorldScale / Math.max(0.0001, frame.targetContentScale)
            : localScaleAfterWorldFit(oldWorldScale, frame.fit, frame.target ? frame.targetContentScale : 1),
          interiorScale: previous?.interiorScale
            ?? positiveFinite((root.data as Record<string, unknown>).interiorScale),
        }
      })
    : []

  // Case 3 writes exactly one extra row: the container's own. Its position,
  // size and scale are untouched — only how much it compresses what it holds.
  const containerUpdate = workspaceId && frame.compression && frame.target && frame.compression.factor !== 1
    ? containerCompressionWrite(frame.target, frame.compression.interiorScale, floorLayouts, systemIds, fileIds, infraIds)
    : null
  if (containerUpdate) updates.push(containerUpdate)

  const changedKeys = new Set(updates.map(update => `${update.nodeType}:${update.nodeId}`))
  return {
    selectedIds,
    updates,
    changedKeys,
    previousLayouts: floorLayouts.filter(layout => changedKeys.has(`${layout.nodeType}:${layout.nodeId}`)),
    optimisticLayouts: workspaceId
      ? updates.map(update => ({ ...update, workspaceId, updatedAt: now }))
      : [],
    arrivalLayouts: workspaceId
      ? updates.map(update => {
          const arrival = arrivalById.get(update.nodeId)
          return {
            ...update,
            workspaceId,
            updatedAt: now,
            // The container's compression row has no arrival of its own: it
            // starts uncompressed so the shrink is something you watch happen.
            ...(arrival
              ? { positionX: arrival.x, positionY: arrival.y, scale: arrival.scale }
              : { interiorScale: frame.target && update.nodeId === frame.target.id
                  ? positiveFinite((frame.target.data as Record<string, unknown>).interiorScale)
                  : update.interiorScale }),
          }
        })
      : [],
  }
}
