import type { Node } from '@xyflow/react'
import type { DbFile, DbInfraNode, DbSystem, FloorNodeType } from '../../shared/types'
import { countDirectChildren } from './directChildCounts.ts'
import { FRAME_CONTENT_PADDING, FRAME_HEADER_HEIGHT, type FrameGeometry } from './frameGeometry.ts'
import { minimumContainerSize } from './resizeGeometry.ts'
import type { FileNodeData, InfraNodeData, SystemNodeData } from './sceneTypes'

const BASE_FILE_WIDTH = 220
const BASE_FILE_HEIGHT = 110
const SYSTEM_PALETTE = ['#5B8A9A', '#C4956A', '#7A9E7E', '#A07B8A']

export interface FloorSceneDescriptor {
  id: string
  nodeType: FloorNodeType
  parentId: string | null
  depth: number
  geometry: FrameGeometry
  worldScale: number
}

interface FloorSceneProjectionInput {
  systems: DbSystem[]
  files: DbFile[]
  infraNodes: DbInfraNode[]
  descriptors: FloorSceneDescriptor[]
  siblingsByParent: Map<string | null, string[]>
  geometryById: Map<string, FrameGeometry>
  worldScaleById: Map<string, number>
  agentTouchedIds: Set<string>
  currentZoom: number
}

function systemColor(depth: number): string {
  return SYSTEM_PALETTE[depth % SYSTEM_PALETTE.length]
}

function hexToRgb(hex: string): string {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `${r}, ${g}, ${b}`
}

/** Convert canonical Floor descriptors into the React Flow scene model. */
export function projectFloorNodes({
  systems,
  files,
  infraNodes,
  descriptors,
  siblingsByParent,
  geometryById,
  worldScaleById,
  agentTouchedIds,
  currentZoom,
}: FloorSceneProjectionInput): Node[] {
  const systemsById = new Map(systems.map(system => [system.id, system]))
  const filesById = new Map(files.map(file => [file.id, file]))
  const infraById = new Map(infraNodes.map(infra => [infra.id, infra]))
  const directChildCounts = countDirectChildren(descriptors)

  const defaultSize = (id: string) => {
    const system = systemsById.get(id)
    if (system) return { width: system.width ?? 620, height: system.height ?? 420 }
    const file = filesById.get(id)
    if (file) return { width: file.width ?? BASE_FILE_WIDTH, height: file.height ?? BASE_FILE_HEIGHT }
    const infra = infraById.get(id)
    return infra?.category === 'platform' ? { width: 760, height: 520 } : { width: 260, height: 160 }
  }

  const resizeMinimumFor = (id: string, geometry: FrameGeometry, worldScale: number) => {
    const childRects = (siblingsByParent.get(id) ?? []).flatMap(childId => {
      const child = geometryById.get(childId)
      return child ? [{
        x: child.x,
        y: child.y,
        width: child.width * child.scale,
        height: child.height * child.scale,
      }] : []
    })
    const minimum = minimumContainerSize(
      { width: geometry.width, height: geometry.height },
      childRects,
      { left: FRAME_CONTENT_PADDING, right: FRAME_CONTENT_PADDING, top: FRAME_HEADER_HEIGHT, bottom: FRAME_CONTENT_PADDING },
      { width: 1, height: 1 },
    )
    return { width: minimum.width * worldScale, height: minimum.height * worldScale }
  }

  return descriptors.map(descriptor => {
    const { id, parentId, geometry, worldScale, depth } = descriptor
    const parentWorldScale = parentId ? (worldScaleById.get(parentId) ?? 1) : 1
    const position = { x: geometry.x * parentWorldScale, y: geometry.y * parentWorldScale }
    const style = { width: geometry.width * worldScale, height: geometry.height * worldScale }

    if (descriptor.nodeType === 'system') {
      const system = systemsById.get(id)!
      const color = system.color ?? systemColor(depth)
      const resizeMinimum = resizeMinimumFor(id, geometry, worldScale)
      const presentationBase = defaultSize(id)
      return {
        id, type: 'system', parentId: parentId ?? undefined, position, style,
        data: {
          id, name: system.name, source: system.source, color, colorRgb: hexToRgb(color),
          description: system.description, agentNotes: system.agentNotes, depth,
          directChildCount: directChildCounts.get(id) ?? 0, agentTouched: agentTouchedIds.has(id),
          currentZoom, isChild: !!parentId, childrenVisible: 0, nodeW: style.width,
          nodeH: style.height, frameScale: geometry.scale, worldScale,
          minResizeWidth: resizeMinimum.width, minResizeHeight: resizeMinimum.height,
          presentationBaseWidth: presentationBase.width * worldScale,
          presentationBaseHeight: presentationBase.height * worldScale,
        } as unknown as Record<string, unknown>,
        draggable: true, selectable: true,
      }
    }

    if (descriptor.nodeType === 'file') {
      const file = filesById.get(id)!
      return {
        id, type: 'file', parentId: parentId ?? undefined, position, style,
        data: {
          id, label: file.relPath.split('/').pop() ?? file.relPath, relPath: file.relPath,
          language: file.language, lineCount: file.lineCount, churnScore: file.churnScore,
          shape: (file.shapeOverride || file.shape || '') as FileNodeData['shape'],
          displayName: file.displayName ?? '', agentTouched: agentTouchedIds.has(id), depth,
          currentZoom, childrenVisible: 0, frameScale: geometry.scale, worldScale,
        } satisfies FileNodeData as unknown as Record<string, unknown>,
        draggable: true, selectable: true,
      }
    }

    const infra = infraById.get(id)!
    if (infra.category === 'platform') {
      const color = '#6b8afd'
      const resizeMinimum = resizeMinimumFor(id, geometry, worldScale)
      const presentationBase = defaultSize(id)
      return {
        id, type: 'system', parentId: parentId ?? undefined, position, style,
        data: {
          id, name: infra.name, source: 'user', color, colorRgb: hexToRgb(color),
          description: null, agentNotes: null, depth,
          directChildCount: directChildCounts.get(id) ?? 0, agentTouched: agentTouchedIds.has(id),
          currentZoom, isChild: !!parentId, childrenVisible: 0, nodeW: style.width,
          nodeH: style.height, frameScale: geometry.scale, worldScale, umlKind: 'infra',
          minResizeWidth: resizeMinimum.width, minResizeHeight: resizeMinimum.height,
          presentationBaseWidth: presentationBase.width * worldScale,
          presentationBaseHeight: presentationBase.height * worldScale,
          umlMetadata: { version: 1, category: infra.category, provider: infra.provider, service: infra.service, subtype: infra.subtype },
        } as unknown as Record<string, unknown>,
        draggable: true, selectable: true,
      }
    }

    return {
      id, type: 'infra', parentId: parentId ?? undefined, position, style,
      data: {
        id, label: infra.name, name: infra.name, infraType: infra.infraType,
        category: infra.category ?? 'api', provider: infra.provider ?? 'generic',
        service: infra.service ?? '', subtype: infra.subtype ?? '', status: infra.status ?? 'confirmed',
        agentTouched: agentTouchedIds.has(id), frameScale: geometry.scale, worldScale,
      } satisfies InfraNodeData as unknown as Record<string, unknown>,
      draggable: true, selectable: true,
    }
  })
}
