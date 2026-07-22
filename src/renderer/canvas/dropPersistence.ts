import type { Node } from '@xyflow/react'
import type { FloorLayout, FloorNodeType } from '../../shared/types'
import type { PlannedNode, SheetElement, SheetLayoutMutation } from '../store/sheetStore'
import {
  boundsOf,
  contentRect,
  findUnscaledIncomingPlacement,
  fitReferenceFrame,
  highestSelectedRoots,
  localScaleAfterWorldFit,
  transformReferencePoint,
  type Point,
  type Rect,
  type ReferenceFrameTransform,
} from './frameGeometry.ts'
import type { FloorLayoutWrite } from './resizePersistence'

const BASE_FILE_WIDTH = 220
const BASE_FILE_HEIGHT = 110

interface DropFrameInput {
  allNodes: Node[]
  selectedIds: string[]
  targetNodeId: string | null
  absolutePositions: ReadonlyMap<string, Point>
  includeExistingChild: (node: Node) => boolean
}

interface DropFrame {
  roots: Node[]
  layoutRoots: Node[]
  target: Node | null
  targetAbsolute: Point
  targetScale: number
  placementRects: Array<Rect & { id: string }>
  incomingIds: Set<string>
  incomingOffset: Point | null
  frameTransform: ReferenceFrameTransform | null
  fit: number
  groupBounds: Rect | null
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
  const targetBox = target ? contentRect({
    width: Number(target.style?.width ?? target.measured?.width ?? 1) / Math.max(0.0001, targetScale),
    height: Number(target.style?.height ?? target.measured?.height ?? 1) / Math.max(0.0001, targetScale),
  }) : null
  const destination = targetBox ? {
    x: targetAbsolute.x + targetBox.x * targetScale,
    y: targetAbsolute.y + targetBox.y * targetScale,
    width: targetBox.width * targetScale,
    height: targetBox.height * targetScale,
  } : null
  const groupBounds = boundsOf(placementRects)
  const incomingBounds = boundsOf(placementRects.filter(rect => incomingIds.has(rect.id)))
  const occupiedRects = placementRects.filter(rect => !incomingIds.has(rect.id))
  const incomingOffset = changesParent && target && destination && incomingBounds
    ? findUnscaledIncomingPlacement(incomingBounds, destination, occupiedRects)
    : null
  const frameTransform = changesParent && target && !incomingOffset && groupBounds && destination && incomingBounds
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
    incomingOffset,
    frameTransform,
    fit: frameTransform?.scale ?? 1,
    groupBounds,
  }
}

function worldPositionFor(rect: Rect & { id: string }, frame: DropFrame): Point {
  if (frame.frameTransform) return transformReferencePoint(rect, frame.frameTransform)
  if (frame.incomingIds.has(rect.id) && frame.incomingOffset) {
    return { x: rect.x + frame.incomingOffset.x, y: rect.y + frame.incomingOffset.y }
  }
  return { x: rect.x, y: rect.y }
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
  })
  const updates = workspaceId && frame.groupBounds
    ? frame.layoutRoots.map(root => {
        const nodeType = nodeTypeFor(root.id, systemIds, fileIds)
        const previous = floorLayouts.find(layout => layout.nodeId === root.id && layout.nodeType === nodeType)
        const rect = frame.placementRects.find(candidate => candidate.id === root.id)!
        const nextWorld = worldPositionFor(rect, frame)
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
          positionX: frame.target ? (nextWorld.x - frame.targetAbsolute.x) / frame.targetScale : nextWorld.x,
          positionY: frame.target ? (nextWorld.y - frame.targetAbsolute.y) / frame.targetScale : nextWorld.y,
          width: previous?.width ?? materializedWidth,
          height: previous?.height ?? materializedHeight,
          scale: localScaleAfterWorldFit(oldWorldScale, frame.fit, frame.target ? frame.targetScale : 1),
        }
      })
    : []
  const changedKeys = new Set(updates.map(update => `${update.nodeType}:${update.nodeId}`))
  return {
    selectedIds,
    updates,
    changedKeys,
    previousLayouts: floorLayouts.filter(layout => changedKeys.has(`${layout.nodeType}:${layout.nodeId}`)),
    optimisticLayouts: workspaceId
      ? updates.map(update => ({ ...update, workspaceId, updatedAt: now }))
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
