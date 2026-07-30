import type { Node } from '@xyflow/react'
import type { DbFile, DbInfraNode, DbSystem, FloorNodeType } from '../../shared/types'
import { countDirectChildren } from './directChildCounts.ts'
import { frameContentInsets, type FrameGeometry } from './frameGeometry.ts'
import { fitPresentationScale, minimumContainerSize } from './resizeGeometry.ts'
import type { FileNodeData, InfraNodeData, SystemNodeData } from './sceneTypes'

const BASE_FILE_WIDTH = 220
const BASE_FILE_HEIGHT = 110
// Depth accents for the warm workbench Floor. Darkened green/tan/olive/rose so
// each reads against the parchment board and cream cards (mirrors the scoped
// canvas material tokens in global.css).
const SYSTEM_PALETTE = ['#3c7d76', '#a06a34', '#5a7d4f', '#8a5a67']

export interface FloorSceneDescriptor {
  id: string
  nodeType: FloorNodeType
  parentId: string | null
  depth: number
  geometry: FrameGeometry
  /** World scale of this frame itself. */
  worldScale: number
  /** World scale this frame hands to its children (own scale x interiorScale). */
  contentScale: number
}

interface FloorSceneProjectionInput {
  systems: DbSystem[]
  files: DbFile[]
  infraNodes: DbInfraNode[]
  descriptors: FloorSceneDescriptor[]
  siblingsByParent: Map<string | null, string[]>
  geometryById: Map<string, FrameGeometry>
  worldScaleById: Map<string, number>
  contentScaleById: Map<string, number>
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
  contentScaleById,
  currentZoom,
}: FloorSceneProjectionInput): Node[] {
  const systemsById = new Map(systems.map(system => [system.id, system]))
  const filesById = new Map(files.map(file => [file.id, file]))
  const infraById = new Map(infraNodes.map(infra => [infra.id, infra]))
  const directChildCounts = countDirectChildren(descriptors)

  /**
   * How far the user has resized this frame away from its authored design size.
   *
   * Both terms are CANONICAL — neither carries world scale — so the value says
   * nothing about nesting depth and nothing about interior compression. That
   * isolation is the whole point: chrome sized from it cannot react to a
   * container shrinking its contents, and depth stays expressed exactly once,
   * through DEPTH_TITLE_PX.
   */
  const presentationScaleFor = (geometry: FrameGeometry, base: { width: number; height: number }) =>
    fitPresentationScale(geometry.width, geometry.height, base.width, base.height)

  const defaultSize = (id: string) => {
    const system = systemsById.get(id)
    if (system) return { width: system.width ?? 620, height: system.height ?? 420 }
    const file = filesById.get(id)
    if (file) return { width: file.width ?? BASE_FILE_WIDTH, height: file.height ?? BASE_FILE_HEIGHT }
    const infra = infraById.get(id)
    return infra?.category === 'platform' ? { width: 760, height: 520 } : { width: 260, height: 160 }
  }

  const resizeMinimumFor = (id: string, geometry: FrameGeometry, worldScale: number, descriptorDepth: number) => {
    const base = defaultSize(id)
    // Children are authored in the frame's CONTENT space. The minimum size is a
    // statement about the frame's OWN space, so interior compression has to be
    // folded in here — a compressed interior genuinely does need less room.
    const interior = geometry.interiorScale
    const childRects = (siblingsByParent.get(id) ?? []).flatMap(childId => {
      const child = geometryById.get(childId)
      return child ? [{
        x: child.x * interior,
        y: child.y * interior,
        width: child.width * child.scale * interior,
        height: child.height * child.scale * interior,
      }] : []
    })
    const minimum = minimumContainerSize(
      { width: geometry.width, height: geometry.height },
      childRects,
      // The same insets every other path uses: one gap on three sides, and the
      // frame's real tab band plus that gap on top. A flat top constant used to
      // let a north handle pull the frame edge down past its own tab, leaving
      // the first child under the header.
      frameContentInsets(geometry.height, descriptorDepth, worldScale),
      { width: 1, height: 1 },
    )
    return {
      width: minimum.width * worldScale,
      height: minimum.height * worldScale,
      westWidth: minimum.westWidth * worldScale,
      northHeight: minimum.northHeight * worldScale,
    }
  }

  return descriptors.map(descriptor => {
    const { id, parentId, geometry, worldScale, contentScale, depth } = descriptor
    // A child sits in its parent's CONTENT space, so its position rides the
    // parent's contentScale — not the parent's own world scale. The two are
    // equal for every frame that does not compress its interior.
    const parentContentScale = parentId ? (contentScaleById.get(parentId) ?? worldScaleById.get(parentId) ?? 1) : 1
    const position = { x: geometry.x * parentContentScale, y: geometry.y * parentContentScale }
    const style = { width: geometry.width * worldScale, height: geometry.height * worldScale }

    if (descriptor.nodeType === 'system') {
      const system = systemsById.get(id)!
      const color = system.color ?? systemColor(depth)
      const resizeMinimum = resizeMinimumFor(id, geometry, worldScale, depth)
      const presentationBase = defaultSize(id)
      return {
        id, type: 'system', parentId: parentId ?? undefined, position, style,
        initialWidth: style.width, initialHeight: style.height,
        data: {
          id, name: system.name, source: system.source, color, colorRgb: hexToRgb(color),
          description: system.description, agentNotes: system.agentNotes, depth,
          directChildCount: directChildCounts.get(id) ?? 0,
          currentZoom, isChild: !!parentId, childrenVisible: 0, nodeW: style.width,
          nodeH: style.height, frameScale: geometry.scale, worldScale, contentScale,
          interiorScale: geometry.interiorScale,
          minResizeWidth: resizeMinimum.width,
          minResizeWidthWest: resizeMinimum.westWidth,
          minResizeHeight: resizeMinimum.height,
          minResizeHeightNorth: resizeMinimum.northHeight,
          presentationBaseWidth: presentationBase.width,
          presentationBaseHeight: presentationBase.height,
          presentationScale: presentationScaleFor(geometry, presentationBase),
        } as unknown as Record<string, unknown>,
        draggable: true, selectable: true,
      }
    }

    if (descriptor.nodeType === 'file') {
      const file = filesById.get(id)!
      return {
        id, type: 'file', parentId: parentId ?? undefined, position, style,
        initialWidth: style.width, initialHeight: style.height,
        data: {
          id, label: file.relPath.split('/').pop() ?? file.relPath, relPath: file.relPath,
          language: file.language, lineCount: file.lineCount, churnScore: file.churnScore,
          shape: (file.shapeOverride || file.shape || '') as FileNodeData['shape'],
          displayName: file.displayName ?? '', depth,
          currentZoom, childrenVisible: 0, frameScale: geometry.scale, worldScale,
        } satisfies FileNodeData as unknown as Record<string, unknown>,
        draggable: true, selectable: true,
      }
    }

    const infra = infraById.get(id)!
    if (infra.category === 'platform') {
      const color = '#6b8afd'
      const resizeMinimum = resizeMinimumFor(id, geometry, worldScale, depth)
      const presentationBase = defaultSize(id)
      return {
        id, type: 'system', parentId: parentId ?? undefined, position, style,
        initialWidth: style.width, initialHeight: style.height,
        data: {
          id, name: infra.name, source: 'user', color, colorRgb: hexToRgb(color),
          description: null, agentNotes: null, depth,
          directChildCount: directChildCounts.get(id) ?? 0,
          currentZoom, isChild: !!parentId, childrenVisible: 0, nodeW: style.width,
          nodeH: style.height, frameScale: geometry.scale, worldScale, contentScale,
          umlKind: 'infra', interiorScale: geometry.interiorScale,
          minResizeWidth: resizeMinimum.width,
          minResizeWidthWest: resizeMinimum.westWidth,
          minResizeHeight: resizeMinimum.height,
          minResizeHeightNorth: resizeMinimum.northHeight,
          presentationBaseWidth: presentationBase.width,
          presentationBaseHeight: presentationBase.height,
          presentationScale: presentationScaleFor(geometry, presentationBase),
          umlMetadata: { version: 1, category: infra.category, provider: infra.provider, service: infra.service, subtype: infra.subtype },
        } as unknown as Record<string, unknown>,
        draggable: true, selectable: true,
      }
    }

    return {
      id, type: 'infra', parentId: parentId ?? undefined, position, style,
      initialWidth: style.width, initialHeight: style.height,
      data: {
        id, label: infra.name, name: infra.name, infraType: infra.infraType,
        category: infra.category ?? 'api', provider: infra.provider ?? 'generic',
        service: infra.service ?? '', subtype: infra.subtype ?? '', status: infra.status ?? 'confirmed',
        frameScale: geometry.scale, worldScale,
      } satisfies InfraNodeData as unknown as Record<string, unknown>,
      draggable: true, selectable: true,
    }
  })
}
