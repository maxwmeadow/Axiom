import type { Node } from '@xyflow/react'
import type { FloorLayout, FloorNodeType } from '../../shared/types'
import type { PlannedNode, SheetElement, SheetLayoutMutation } from '../store/sheetStore'
import { childPositionAfterParentResize, toCanonicalResizeGeometry, type NodeResizeParams } from './resizeGeometry.ts'

export interface ResizeSessionStart extends NodeResizeParams {
  children: Map<string, { x: number; y: number }>
}

export type FloorLayoutWrite = Omit<FloorLayout, 'workspaceId' | 'updatedAt'>

interface SheetResizePlanInput {
  nodeId: string
  node: Node
  start: ResizeSessionStart
  end: NodeResizeParams
  elements: SheetElement[]
  planned: PlannedNode[]
}

interface FloorResizePlanInput {
  workspaceId: string
  nodeId: string
  node: Node
  start: ResizeSessionStart
  end: NodeResizeParams
  nodes: Node[]
  systemIds: Set<string>
  fileIds: Set<string>
  infraIds: Set<string>
  floorLayouts: FloorLayout[]
  now?: number
}

export interface FloorResizePersistencePlan {
  updates: FloorLayoutWrite[]
  changedKeys: Set<string>
  previousLayouts: FloorLayout[]
  optimisticLayouts: FloorLayout[]
}

function nodeTypeFor(id: string, systemIds: Set<string>, fileIds: Set<string>): FloorNodeType {
  if (systemIds.has(id)) return 'system'
  if (fileIds.has(id)) return 'file'
  return 'infra'
}

/**
 * A layout write replaces the whole row, so any writer that is not *about*
 * interior compression has to carry the current value through. Persisted state
 * wins over projected state, which can lag a save by a frame.
 */
export function previousInteriorScale(
  floorLayouts: readonly FloorLayout[],
  nodeId: string,
  nodeType: FloorNodeType,
  node?: Node,
): number {
  const persisted = floorLayouts.find(layout => layout.nodeId === nodeId && layout.nodeType === nodeType)
  const candidate = persisted?.interiorScale
    ?? Number((node?.data as Record<string, unknown> | undefined)?.interiorScale ?? 1)
  return Number.isFinite(candidate) && candidate > 0 ? candidate : 1
}

function canonicalResize(node: Node, end: NodeResizeParams) {
  const ownScale = Number((node.data as Record<string, unknown>).frameScale ?? 1)
  const worldScale = Number((node.data as Record<string, unknown>).worldScale ?? ownScale)
  return {
    ownScale,
    worldScale,
    geometry: toCanonicalResizeGeometry(end, worldScale, ownScale, !!node.parentId),
  }
}

function sheetMutationFor(
  renderedId: string,
  x: number,
  y: number,
  parentSystemId: string | null,
  elements: SheetElement[],
  planned: PlannedNode[],
  size?: { width: number; height: number; scale: number },
): SheetLayoutMutation | null {
  const member = elements.find(item => (item.systemId ?? item.fileId ?? item.infraId) === renderedId)
  if (member) return { kind: 'element', id: member.id, x, y, parentSystemId, ...size }
  const plannedNode = renderedId.startsWith('planned:')
    ? planned.find(item => item.id === renderedId.slice(8))
    : undefined
  return plannedNode ? { kind: 'planned', id: plannedNode.id, x, y, parentSystemId, ...size } : null
}

export function planSheetResize({
  nodeId,
  node,
  start,
  end,
  elements,
  planned,
}: SheetResizePlanInput): SheetLayoutMutation[] | null {
  const { ownScale, worldScale, geometry } = canonicalResize(node, end)
  const parentMutation = sheetMutationFor(
    nodeId,
    geometry.x,
    geometry.y,
    node.parentId ?? null,
    elements,
    planned,
    { width: geometry.width, height: geometry.height, scale: ownScale },
  )
  if (!parentMutation) return null

  const childMutations = [...start.children].flatMap(([childId, childStart]) => {
    const position = childPositionAfterParentResize(childStart, start, end, worldScale)
    const mutation = sheetMutationFor(childId, position.x, position.y, nodeId, elements, planned)
    return mutation ? [mutation] : []
  })
  return [parentMutation, ...childMutations]
}

export function planFloorResize({
  workspaceId,
  nodeId,
  node,
  start,
  end,
  nodes,
  systemIds,
  fileIds,
  infraIds,
  floorLayouts,
  now = Date.now(),
}: FloorResizePlanInput): FloorResizePersistencePlan {
  const { ownScale, worldScale, geometry } = canonicalResize(node, end)
  const nodeType = nodeTypeFor(nodeId, systemIds, fileIds)
  const parentId = node.parentId ?? null
  const parentType = parentId ? (infraIds.has(parentId) ? 'infra' : 'system') : null
  const nextLayout: FloorLayoutWrite = {
    nodeId,
    nodeType,
    parentNodeId: parentId,
    parentNodeType: parentType,
    containmentKind: parentType === 'infra' ? 'hosted_by' : parentType === 'system' ? 'part_of' : 'root',
    positionX: geometry.x,
    positionY: geometry.y,
    width: geometry.width,
    height: geometry.height,
    scale: ownScale,
    // Resizing a frame changes how much room it has, never how much it
    // compresses what it holds. Preserve the existing value verbatim.
    interiorScale: previousInteriorScale(floorLayouts, nodeId, nodeType, node),
  }

  // Children are stored in the frame's CONTENT space, so their compensation
  // divides by contentScale — equal to worldScale unless the frame compresses.
  const contentScale = Number((node.data as Record<string, unknown>).contentScale ?? worldScale)

  const childLayouts: FloorLayoutWrite[] = [...start.children].flatMap(([childId, childStart]) => {
    const childNode = nodes.find(candidate => candidate.id === childId)
    if (!childNode) return []
    const childType = nodeTypeFor(childId, systemIds, fileIds)
    const childPrevious = floorLayouts.find(layout => layout.nodeId === childId && layout.nodeType === childType)
    const childData = childNode.data as Record<string, unknown>
    const childOwnScale = childPrevious?.scale ?? Number(childData.frameScale ?? 1)
    const childWorldScale = Number(childData.worldScale ?? contentScale * childOwnScale)
    const position = childPositionAfterParentResize(childStart, start, end, contentScale)
    return [{
      nodeId: childId,
      nodeType: childType,
      parentNodeId: nodeId,
      parentNodeType: nodeType === 'infra' ? 'infra' : 'system',
      containmentKind: nodeType === 'infra' ? 'hosted_by' : 'part_of',
      positionX: position.x,
      positionY: position.y,
      width: childPrevious?.width ?? Number(childNode.style?.width ?? childNode.measured?.width ?? 1) / Math.max(0.0001, childWorldScale),
      height: childPrevious?.height ?? Number(childNode.style?.height ?? childNode.measured?.height ?? 1) / Math.max(0.0001, childWorldScale),
      scale: childOwnScale,
      interiorScale: childPrevious?.interiorScale ?? Number(childData.interiorScale ?? 1),
    }]
  })

  const updates = [nextLayout, ...childLayouts]
  const changedKeys = new Set(updates.map(layout => `${layout.nodeType}:${layout.nodeId}`))
  return {
    updates,
    changedKeys,
    previousLayouts: floorLayouts.filter(layout => changedKeys.has(`${layout.nodeType}:${layout.nodeId}`)),
    optimisticLayouts: updates.map(layout => ({ ...layout, workspaceId, updatedAt: now })),
  }
}

export function replaceFloorLayouts(
  current: FloorLayout[],
  replacements: FloorLayout[],
  changedKeys: Set<string>,
): FloorLayout[] {
  return [
    ...current.filter(layout => !changedKeys.has(`${layout.nodeType}:${layout.nodeId}`)),
    ...replacements,
  ]
}
