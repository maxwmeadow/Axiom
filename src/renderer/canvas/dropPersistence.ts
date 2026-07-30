import type { Node } from '@xyflow/react'
import type { FloorLayout, FloorNodeType } from '../../shared/types'
import type { PlannedNode, SheetElement, SheetLayoutMutation } from '../store/sheetStore'
import {
  boundsOf,
  contentRectFor,
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
import { placeNearest } from './packing.ts'
import { type FloorLayoutWrite } from './resizePersistence.ts'

const BASE_FILE_WIDTH = 220
const BASE_FILE_HEIGHT = 110

interface DropFrameInput {
  allNodes: Node[]
  selectedIds: string[]
  targetNodeId: string | null
  absolutePositions: ReadonlyMap<string, Point>
  includeExistingChild: (node: Node) => boolean
  /**
   * Enables case 3. The Floor can compress a frame's interior; the sheet layer
   * has no such concept and falls back to the group transform.
   */
  allowInteriorCompression?: boolean
}

interface DropFrame {
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
}

interface FloorDropPlanInput {
  workspaceId: string | null
  draggedNodeId: string
  targetNodeId: string | null
  allNodes: Node[]
  absolutePositions: ReadonlyMap<string, Point>
  systemIds: Set<string>
  fileIds: Set<string>
  infraIds: Set<string>
  floorLayouts: FloorLayout[]
  now?: number
}

interface SheetDropPlanInput {
  draggedNodeId: string
  targetNodeId: string | null
  allNodes: Node[]
  absolutePositions: ReadonlyMap<string, Point>
  activeNodeIds: ReadonlySet<string>
  elements: SheetElement[]
  planned: PlannedNode[]
}

export interface FloorDropPersistencePlan {
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

export interface SheetDropPersistencePlan {
  selectedIds: string[]
  mutations: SheetLayoutMutation[]
}

function nodeTypeFor(id: string, systemIds: Set<string>, fileIds: Set<string>): FloorNodeType {
  if (systemIds.has(id)) return 'system'
  if (fileIds.has(id)) return 'file'
  return 'infra'
}

function buildDropFrame({
  allNodes,
  selectedIds,
  targetNodeId,
  absolutePositions,
  includeExistingChild,
  allowInteriorCompression = false,
}: DropFrameInput): DropFrame {
  const parentById = new Map(allNodes.map(node => [node.id, node.parentId ?? null]))
  const roots = highestSelectedRoots(selectedIds, parentById)
    .map(id => allNodes.find(node => node.id === id))
    .filter((node): node is Node => !!node)
  const target = targetNodeId ? allNodes.find(node => node.id === targetNodeId) ?? null : null
  const changesParent = !!target && roots.some(root => root.parentId !== target.id)
  const incomingIds = new Set(roots.map(root => root.id))
  const layoutRoots = changesParent && target
    ? [
        ...allNodes.filter(node => node.parentId === target.id && includeExistingChild(node) && !incomingIds.has(node.id)),
        ...roots,
      ]
    : roots
  const placementRects = layoutRoots.map(root => {
    const absolute = absolutePositions.get(root.id) ?? root.position
    return {
      id: root.id,
      x: absolute.x,
      y: absolute.y,
      width: Number(root.measured?.width ?? root.style?.width ?? 1),
      height: Number(root.measured?.height ?? root.style?.height ?? 1),
    }
  })
  const targetAbsolute = target ? absolutePositions.get(target.id) ?? { x: 0, y: 0 } : { x: 0, y: 0 }
  const targetScale = target ? Number((target.data as Record<string, unknown>).worldScale ?? 1) : 1
  // Children live in the target's CONTENT space. It differs from the target's
  // own world scale exactly when the target already compresses its interior.
  const targetContentScale = target
    ? Number((target.data as Record<string, unknown>).contentScale ?? targetScale)
    : 1
  const targetInteriorScale = target
    ? Number((target.data as Record<string, unknown>).interiorScale ?? 1)
    : 1
  // Size parity: a node arriving from elsewhere carries its own world scale,
  // so applying one fit factor to every node left the newcomer a different
  // size from the siblings it just joined. Adopt the scale they already use.
  const siblingWorldScales = allNodes
    .filter(node => target && node.parentId === target.id && !incomingIds.has(node.id))
    .map(node => Number((node.data as Record<string, unknown>).worldScale ?? 0))
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
  const siblingWorldScale = siblingWorldScales.length > 0
    ? siblingWorldScales[Math.floor(siblingWorldScales.length / 2)]
    : null
  // Header-aware, exactly like the resize clamp and the resize minimum. Using
  // `contentRect`'s flat defaults here made a drop and a resize disagree about
  // where a frame's usable space begins.
  const targetBox = target ? contentRectFor(
    {
      width: Number(target.style?.width ?? target.measured?.width ?? 1) / Math.max(0.0001, targetScale),
      height: Number(target.style?.height ?? target.measured?.height ?? 1) / Math.max(0.0001, targetScale),
    },
    Number((target.data as Record<string, unknown>).depth ?? 0),
    targetScale,
  ) : null
  const destination = targetBox ? {
    x: targetAbsolute.x + targetBox.x * targetScale,
    y: targetAbsolute.y + targetBox.y * targetScale,
    width: targetBox.width * targetScale,
    height: targetBox.height * targetScale,
  } : null
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
  // These rects are ABSOLUTE WORLD geometry, while FRAME_ITEM_GAP is authored
  // in canonical units, so the clearance converts through the content scale.
  // Without this a frame nested at half scale enforced twice the gap.
  const worldGap = FRAME_ITEM_GAP * Math.max(0.0001, targetContentScale)
  const collidesAt = (position: Point, size: Rect): boolean => occupiedRects.some(rect =>
    position.x < rect.x + rect.width + worldGap &&
    position.x + size.width + worldGap > rect.x &&
    position.y < rect.y + rect.height + worldGap &&
    position.y + size.height + worldGap > rect.y)

  // Step 1 is a plain minimal clamp. It used to be a "wall-directed" search
  // that pushed the node to the MIDPOINT of the largest free run — so a node
  // dropped a few pixels above a frame's tab flew hundreds of units down the
  // frame, while every other path nudged by the smallest amount that worked.
  // A drop that already sits clear keeps its exact position, as before.
  const directOffset = changesParent && target && destination && incomingBounds
    ? (() => {
        const clamped = containPointWithin(incomingBounds, incomingBounds, destination)
        return collidesAt(clamped, incomingBounds)
          ? null
          : { x: clamped.x - incomingBounds.x, y: clamped.y - incomingBounds.y }
      })()
    : null
  const slidOffset = !directOffset && changesParent && target && destination && incomingBounds
    ? slideIncomingIntoFreeSlot(incomingBounds, destination, occupiedRects, worldGap)
    : null
  const incomingOffset = directOffset ?? slidOffset

  // Case 3. Only reached when neither the drop point nor any free slot works.
  // The whole computation happens in the target's CONTENT space, because that
  // is the space the children are stored in and the space compression acts on.
  const needsCompression = changesParent && !!target && !incomingOffset && !!destination && !!incomingBounds
  const compression = needsCompression && allowInteriorCompression && target && destination && incomingBounds
    ? planInteriorCompression(
        {
          // Content box in the target's OWN canonical space.
          ownContent: contentRectFor(
            {
              width: Number(target.style?.width ?? target.measured?.width ?? 1) / Math.max(0.0001, targetScale),
              height: Number(target.style?.height ?? target.measured?.height ?? 1) / Math.max(0.0001, targetScale),
            },
            Number((target.data as Record<string, unknown>).depth ?? 0),
            targetScale,
          ),
          occupied: occupiedRects.map(rect => toContentSpace(rect, targetAbsolute, targetContentScale)),
          incoming: incomingSizeAtSiblingScale(incomingBounds, roots, siblingWorldScale, targetContentScale),
          origin: toContentSpace(incomingBounds, targetAbsolute, targetContentScale),
          interiorScale: targetInteriorScale,
          // The legibility floor binds on the SMALLEST child, so a frame that
          // already holds tiny nodes gets little further headroom.
          minChildWorldScale: smallestChildWorldScale(allNodes, target.id, incomingIds, siblingWorldScale),
          gap: FRAME_ITEM_GAP,
        },
        slideIncomingIntoFreeSlot,
      )
    : null

  // The sheet layer has no interior lever, so it keeps the group transform.
  const frameTransform = needsCompression && !allowInteriorCompression && groupBounds && destination && incomingBounds
    ? fitReferenceFrame(groupBounds, destination, incomingBounds)
    : null
  return {
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
  const ownWorldScale = Math.max(0.0001, Number((roots[0].data as Record<string, unknown>).worldScale ?? 1))
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
    .map(node => Number((node.data as Record<string, unknown>).worldScale ?? 1))
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
 * dropped. `placeIncoming` treats existing children as fixed obstacles, so
 * this never disturbs an arrangement the user has already set up — it only
 * decides where the newcomer lands. Returns the translation to apply, or null
 * if the frame has no room at all.
 */
export function slideIncomingIntoFreeSlot(
  incoming: Rect,
  destination: Rect,
  occupied: readonly Rect[],
  gap = FRAME_ITEM_GAP,
): Point | null {
  const placed = placeNearest(
    { id: '__incoming__', width: incoming.width, height: incoming.height },
    occupied,
    { baseGap: gap, bounds: destination, preferred: { x: incoming.x, y: incoming.y } },
  )
  if (!placed) return null
  return { x: placed.x - incoming.x, y: placed.y - incoming.y }
}

function worldPositionFor(rect: Rect & { id: string }, frame: DropFrame): Point {
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
  const ownScale = Number(data.frameScale ?? 1)
  const worldScale = Number(data.worldScale ?? ownScale)
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
    width: Number(target.style?.width ?? target.measured?.width ?? 1) / Math.max(0.0001, worldScale),
    height: Number(target.style?.height ?? target.measured?.height ?? 1) / Math.max(0.0001, worldScale),
    scale: ownScale,
    interiorScale,
  }
}

function selectedIdsForDrop(nodes: Node[], draggedNodeId: string, eligible: (node: Node) => boolean): string[] {
  const selected = nodes.filter(node => node.selected && eligible(node)).map(node => node.id)
  if (!selected.includes(draggedNodeId)) selected.push(draggedNodeId)
  return selected
}

export function planFloorDrop({
  workspaceId,
  draggedNodeId,
  targetNodeId,
  allNodes,
  absolutePositions,
  systemIds,
  fileIds,
  infraIds,
  floorLayouts,
  now = Date.now(),
}: FloorDropPlanInput): FloorDropPersistencePlan {
  const selectedIds = selectedIdsForDrop(allNodes, draggedNodeId, () => true)
  const frame = buildDropFrame({
    allNodes,
    selectedIds,
    targetNodeId,
    absolutePositions,
    includeExistingChild: () => true,
    allowInteriorCompression: true,
  })
  // Cases 1-3 all leave existing children exactly where they are, so only the
  // newcomers get a row — compression moves the space, not the nodes in it.
  //
  // Writing residents too was harmless while the plan echoed their current
  // geometry back, but the containment clamp is applied to every row it writes:
  // a resident overlapping its frame's tab band got silently nudged by an
  // unrelated drop. `layoutRoots` now only matters to the sheet layer, whose
  // group transform genuinely does move everyone.
  const writtenRoots = frame.roots
  // Where each node physically was when the pointer came up, expressed in its
  // NEW parent's coordinate space. Phase one of the drop puts it here, so the
  // reparent itself is visually a no-op and every correction after it animates.
  const arrivalById = new Map<string, { x: number; y: number; scale: number }>()
  for (const root of writtenRoots) {
    const rect = frame.placementRects.find(candidate => candidate.id === root.id)!
    const ownWorldScale = Number((root.data as Record<string, unknown>).worldScale ?? 1)
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
        const oldWorldScale = Number((root.data as Record<string, unknown>).worldScale ?? previous?.scale ?? 1)
        const materializedWidth = Number(root.style?.width ?? rect.width) / Math.max(0.0001, oldWorldScale)
        const materializedHeight = Number(root.style?.height ?? rect.height) / Math.max(0.0001, oldWorldScale)
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
            ?? Number((root.data as Record<string, unknown>).interiorScale ?? 1),
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
                  ? Number((frame.target.data as Record<string, unknown>).interiorScale ?? 1)
                  : update.interiorScale }),
          }
        })
      : [],
  }
}

export function planSheetDrop({
  draggedNodeId,
  targetNodeId,
  allNodes,
  absolutePositions,
  activeNodeIds,
  elements,
  planned,
}: SheetDropPlanInput): SheetDropPersistencePlan {
  const selectedIds = selectedIdsForDrop(allNodes, draggedNodeId, node => activeNodeIds.has(node.id))
  const frame = buildDropFrame({
    allNodes,
    selectedIds,
    targetNodeId,
    absolutePositions,
    includeExistingChild: node => activeNodeIds.has(node.id),
  })
  const mutations: SheetLayoutMutation[] = []
  if (frame.groupBounds) {
    for (const root of frame.layoutRoots) {
      const element = elements.find(item => (item.systemId ?? item.fileId ?? item.infraId) === root.id)
      const plannedNode = root.id.startsWith('planned:')
        ? planned.find(item => item.id === root.id.slice(8))
        : undefined
      if (!element && !plannedNode) continue
      const rect = frame.placementRects.find(item => item.id === root.id)!
      const world = worldPositionFor(rect, frame)
      const oldScale = Number((root.data as Record<string, unknown>).worldScale ?? element?.scale ?? plannedNode?.scale ?? 1)
      mutations.push({
        kind: element ? 'element' : 'planned',
        id: element?.id ?? plannedNode!.id,
        x: frame.target ? (world.x - frame.targetAbsolute.x) / frame.targetScale : world.x,
        y: frame.target ? (world.y - frame.targetAbsolute.y) / frame.targetScale : world.y,
        parentSystemId: frame.target?.id ?? null,
        width: Number(element?.width ?? plannedNode?.width ?? root.style?.width ?? (root.type === 'file' ? BASE_FILE_WIDTH : 620)),
        height: Number(element?.height ?? plannedNode?.height ?? root.style?.height ?? (root.type === 'file' ? BASE_FILE_HEIGHT : 420)),
        scale: localScaleAfterWorldFit(oldScale, frame.fit, frame.target ? frame.targetScale : 1),
      })
    }
  }
  return { selectedIds, mutations }
}
