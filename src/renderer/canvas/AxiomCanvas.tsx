/**
 * AxiomCanvas - Infinity-zoom codebase graph.
 *
 * Everything is a node. Zoom controls opacity only - layout never rebuilds on zoom.
 *
 * Sizing philosophy:
 *   - Leaf systems: fixed size by depth (LEAF_W/H)
 *   - Container systems: recursive bottom-up - sized to fit their actual children
 *   - Top-level: grid of depth-0 nodes with collision resolution
 *   Every level uses cols = ceil(sqrt(N)) for a square grid.
 *   Sizes cascade bottom-up: containers fit their children exactly.
 *
 * Zoom thresholds:
 *   Dynamically computed from actual layout sizes after each layout pass.
 *   threshold[d] = TARGET_SCREEN_PX / smallestNodeWidth[d-1]
 *   This means children appear when the smallest parent at that depth fills
 *   ~400px of viewport - a "late reveal" Google Maps feel.
 *   Transitions use continuous fade (opacity + scale + blur) over a 30% range.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  useStoreApi,
  useNodesInitialized,
  useViewport,
  type Node,
  type Edge,
  type NodeTypes,
  type OnNodesChange,
  type OnEdgesChange,
  type OnNodeDrag,
  type OnMove,
  type Connection,
  applyNodeChanges,
  applyEdgeChanges,
  SelectionMode,
  Panel,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
// ELK removed

import { SystemNode } from './nodes/SystemNode'
import { FileNode } from './nodes/FileNode'
import { InfraNode } from './nodes/InfraNode'
import { OrthogonalEdge } from './edges/OrthogonalEdge'
import { useGraphStore } from '../store/graphStore'
import { useShallow } from 'zustand/react/shallow'
import type { DbSystem, DbFile, DbInfraNode, DbDependency, FloorLayout, FloorNodeType } from '../../shared/types'
import { isCanvasSourceFile } from '../../shared/fileKinds'
import { BINNED_FILE_MIME, CanvasBins } from '../components/CanvasBins'
import { partitionCanvasFiles } from './binModel'
import { dropOnFloorAt, registerFloorDropTarget, systemAtFloorPoint } from './binDropBridge'
import { hideBinGhost, hideRealNode, moveBinGhost, showBinGhost } from './binDragGhost'
import { GroupDialog } from '../components/GroupDialog'
import { NewSheetDialog } from '../components/NewSheetDialog'
import { SheetPalette, type StencilDef } from '../components/SheetPalette'
import { InfraPickerDialog } from '../components/InfraPickerDialog'
import { plannedMembers, plannedMetadata, sheetElementMetadata, useSheetStore } from '../store/sheetStore'
import type { PlannedNodeKind, PlannedNodeMetadata, SheetLayoutMutation } from '../store/sheetStore'
import { filenameForLanguage, languageFromFilename } from './languages'
import {
  apiAssignFile,
  apiRemoveFloorLayouts,
  apiSaveFloorLayouts,
  apiSaveNodePosition,
  apiUpdateSystem,
} from './arcdApi'
import { contentRectFor, FRAME_ITEM_GAP, FRAME_ROOT_GAP, frameContentInsets, normalizeGeometry } from './frameGeometry'
import { packFrame, placeIncoming } from './packing'
import { resizeChanged, type NodeResizeParams } from './resizeGeometry'
import { planCanvasResize, replaceFloorLayouts, type ResizeSessionStart } from './resizePersistence'
import { projectFloorNodes, type FloorSceneDescriptor } from './floorSceneProjection'
import { canPersistGeneratedFrame, growFrameToContainChildren, orderFramePlacementCandidates } from './incrementalFrameLayout'
import { easeViewportTowardZoom, MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM, nextWheelZoomTarget, ZOOM_SNAP_EPSILON, zoomViewportAroundPoint } from './viewportMath'
import {
  emptySelection,
  isAdditiveEvent,
  selectionAfterDragStart,
  selectionAfterNodeChanges,
  singleNodeSelection,
  stampSelection,
} from './selectionController'
import { planCanvasDrop } from './dropPersistence'
import { applyZoomVisibility, makeFullyVisible, revealNodePath } from './semanticZoom'
import { livingVisibilityIndex, surfaceLivingNodeFx } from './livingVisibility'
import { applyDeltaMarks, buildDeltaReview, claimFocusTargets, clampClaimCursor } from './deltaReview'
import { applyAgentAttention, surfaceAgentAttention } from './agentAttentionProjection'
import { useSheetPhase } from './sheetPhase'
import { stampAgentPresence } from './agentPresence'
import { LivingFlowOverlay } from './LivingFlowOverlay'
import { inspectFloorScene, partitionCanvasNodeChanges } from './sceneIntegrity'
import { CANVAS_SCOPE_ATTR, useCanvasWasdPan } from './useCanvasWasdPan'
import { routeWheelEvent, wheelScrollStep } from './wheelRouting'
import { rectContainsRect } from './selectionResize'
import { sheetEditableNodeIds } from './sheetEditability'
import { advanceSceneMeasurement, sceneMeasurementIsSettled } from './initialCameraFit'
import {
  LARGE_SCENE_NODE_COUNT,
  VIEWPORT_CULLING_NODE_COUNT,
  shouldDeferCanvasMaterialization,
} from './canvasPerformance'
import {
  diffScene,
  recordSceneMutation,
  sceneDeltaIsQuiet,
  sceneGeometry,
  type SceneNodeGeometry,
} from './sceneDiagnostics'

// A wheel gesture keeps its scroll target until this long after its last event.
const WHEEL_LATCH_MS = 220

/** Matches the .layout-transition duration in global.css. */
const LAYOUT_TRANSITION_MS = 500

// Morning Delta framing bounds. Showing someone a change is not the same as
// pointing the camera at it: the floor stops a claim about two small files
// from landing at an illegible scale, the ceiling stops a two-system boundary
// from filling the viewport with a single box, and the generous padding keeps
// the surrounding architecture visible so the change has context.
const DELTA_REVIEW_MIN_ZOOM = 0.45
const DELTA_REVIEW_MAX_ZOOM = 0.95
const DELTA_REVIEW_PADDING = 0.5

/** Opt-in pointer/geometry drag tracing. Off by default: it is expensive. */
function dragTraceEnabled(): boolean {
  return (globalThis as { __axiomDragTrace?: boolean }).__axiomDragTrace === true
}

// ─── Node type registry ────────────────────────────────────────────────────

export const NODE_TYPES: NodeTypes = {
  system:  SystemNode     as any,
  file:    FileNode       as any,
  infra:   InfraNode      as any,
}

const EDGE_TYPES = {
  orthogonal: OrthogonalEdge as any,
}

type MoveTraceRow = Record<string, string | number | boolean | null>

type NodeMoveTrace = {
  session: number
  nodeId: string
  startedAt: number
  lastLiveLogAt: number
  startClientX: number
  startClientY: number
  previousClientX: number
  previousClientY: number
  startFlowX: number
  startFlowY: number
  startNodeX: number
  startNodeY: number
  startAbsoluteX: number
  startAbsoluteY: number
  startDomLeft: number | null
  startDomTop: number | null
  previousNodeX: number
  previousNodeY: number
  previousChangeByNodeId: Map<string, { x: number; y: number }>
  callbackRows: MoveTraceRow[]
  changeRows: MoveTraceRow[]
}

function pointerTraceCoordinates(event: unknown): {
  clientX: number
  clientY: number
  movementX: number | null
  movementY: number | null
  coalescedEvents: number
  pointerType: string
} {
  const candidate = event as {
    clientX?: number
    clientY?: number
    movementX?: number
    movementY?: number
    pointerType?: string
    touches?: ArrayLike<{ clientX: number; clientY: number }>
    nativeEvent?: unknown
  }
  const touch = candidate.touches?.[0]
  const native = (candidate.nativeEvent ?? candidate) as {
    movementX?: number
    movementY?: number
    pointerType?: string
    getCoalescedEvents?: () => unknown[]
  }
  return {
    clientX: candidate.clientX ?? touch?.clientX ?? 0,
    clientY: candidate.clientY ?? touch?.clientY ?? 0,
    movementX: typeof native.movementX === 'number' ? native.movementX : null,
    movementY: typeof native.movementY === 'number' ? native.movementY : null,
    coalescedEvents: typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents().length : 0,
    pointerType: native.pointerType ?? (touch ? 'touch' : 'mouse'),
  }
}

function renderedNodeRect(nodeId: string): DOMRect | null {
  const elements = document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')
  for (const element of elements) {
    if (element.dataset.id === nodeId) return element.getBoundingClientRect()
  }
  return null
}

// ─── World-space sizing ────────────────────────────────────────────────────
// One scale factor halves the cell size per depth level.
// One gap value drives everything: gap = floor(cellH / 2).
// Container formula (same for width and height):
//   width  = n_cols * cw + (n_cols + 1) * gap
//   height = n_rows * ch + (n_rows + 1) * gap
// The header area equals one gap, so the formula is symmetric in all directions.

export const BASE_FILE_W = 220   // cell width inside a depth-0 system
export const BASE_FILE_H = 110   // cell height inside a depth-0 system
const FILE_SCALE  = 2.0   // cell size halves each depth level

/** Cell (file node) size at a given depth. */
function fileNodeSize(depth: number): { w: number; h: number } {
  const s = Math.pow(FILE_SCALE, Math.max(0, depth))
  return {
    w: Math.max(80, Math.round(BASE_FILE_W / s)),
    h: Math.max(44, Math.round(BASE_FILE_H / s)),
  }
}

/** Uniform gap between / around every cell at depth. Also the header height. */
function gridGap(depth: number): number {
  return Math.floor(fileNodeSize(Math.max(0, depth)).h / 2)
}

/** Total container width for n columns at depth: n*cw + (n+1)*gap */
function containerW(n: number, depth: number): number {
  const { w: cw } = fileNodeSize(depth)
  const gap = gridGap(depth)
  return n * cw + (n + 1) * gap
}

/** Total container height for n rows at depth: n*ch + (n+1)*gap */
function containerH(n: number, depth: number): number {
  const { h: ch } = fileNodeSize(depth)
  const gap = gridGap(depth)
  return n * ch + (n + 1) * gap
}

/** X position of column col inside a container at depth. */
function cellX(col: number, depth: number): number {
  const { w: cw } = fileNodeSize(depth)
  const gap = gridGap(depth)
  return (col + 1) * gap + col * cw
}

/** Y position of row inside a container at depth. */
function cellY(row: number, depth: number): number {
  const { h: ch } = fileNodeSize(depth)
  const gap = gridGap(depth)
  return (row + 1) * gap + row * ch
}

/** How many parent cells a child of naturalSize spans. */
function wUnitsFor(naturalW: number, parentDepth: number): number {
  const { w: cw } = fileNodeSize(parentDepth)
  const gap = gridGap(parentDepth)
  return Math.max(1, Math.ceil((naturalW + gap) / (cw + gap)))
}
function hUnitsFor(naturalH: number, parentDepth: number): number {
  const { h: ch } = fileNodeSize(parentDepth)
  const gap = gridGap(parentDepth)
  return Math.max(1, Math.ceil((naturalH + gap) / (ch + gap)))
}

function snappedW(wUnits: number, parentDepth: number): number {
  const { w: cw } = fileNodeSize(parentDepth)
  const gap = gridGap(parentDepth)
  return wUnits * (cw + gap) - gap
}
function snappedH(hUnits: number, parentDepth: number): number {
  const { h: ch } = fileNodeSize(parentDepth)
  const gap = gridGap(parentDepth)
  return hUnits * (ch + gap) - gap
}

// ─── Alternate Axis Layout Algorithm ──────────────────────────────────────────

interface LayoutNodeResult {
  x: number
  y: number
  w: number
  h: number
}

function runAlternateAxisLayout(
  systems: DbSystem[],
  files: DbFile[],
  infraNodes: DbInfraNode[],
  dependencies: DbDependency[],
  existingMap: Map<string, any>
): Map<string, LayoutNodeResult> {
  const rootParentOf = new Map<string, string>()

  // Fill for systems
  for (const s of systems) {
    let cur = s
    const visited = new Set<string>([cur.id])
    while (cur.parentId) {
      const p = systems.find(x => x.id === cur.parentId)
      if (!p || visited.has(p.id)) break
      visited.add(p.id)
      cur = p
    }
    rootParentOf.set(s.id, cur.id)
  }

  // Fill for files
  for (const f of files) {
    if (f.systemId) {
      const rootSysId = rootParentOf.get(f.systemId)
      if (rootSysId) {
        rootParentOf.set(f.id, rootSysId)
      }
    }
  }

  // Infra nodes map to themselves
  for (const inf of infraNodes) {
    rootParentOf.set(inf.id, inf.id)
  }
  const parentMap = new Map<string, string>()
  for (const f of files) {
    if (f.systemId) parentMap.set(f.id, f.systemId)
  }
  for (const s of systems) {
    if (s.parentId) parentMap.set(s.id, s.parentId)
  }

  const childrenOf = new Map<string | null, DbSystem[]>()
  for (const sys of systems) {
    const key = sys.parentId ?? null
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key)!.push(sys)
  }

  const filesOf = new Map<string | null, DbFile[]>()
  for (const f of files) {
    const key = f.systemId ?? null
    if (!filesOf.has(key)) filesOf.set(key, [])
    filesOf.get(key)!.push(f)
  }

  const computedPositions = new Map<string, LayoutNodeResult>()
  const computedSizes = new Map<string, { w: number; h: number }>()
  // An explicit seed map means positions are authoritative. Inferring this
  // from system-node metadata was brittle (sheet seeds and file-only sheets
  // legitimately have no typed system entry) and caused every composition to
  // rerun the root force layout.
  const isTidy = existingMap.size === 0

  const getSortKey = (id: string) => {
    const ext = existingMap.get(id)
    let x = 0, y = 0
    if (ext?.position?.x !== undefined && ext?.position?.y !== undefined) {
      x = ext.position.x
      y = ext.position.y
    } else {
      const sys = systems.find(s => s.id === id)
      if (sys?.positionX !== undefined && sys?.positionY !== undefined) {
        x = sys.positionX
        y = sys.positionY
      } else {
        const f = files.find(file => file.id === id)
        if (f?.positionX !== undefined && f?.positionY !== undefined) {
          x = f.positionX
          y = f.positionY
        } else {
          const inf = infraNodes.find(i => i.id === id)
          if (inf?.positionX !== undefined && inf?.positionY !== undefined) {
            x = inf.positionX
            y = inf.positionY
          }
        }
      }
    }
    return y * 10000 + x
  }

  function layoutNode(systemId: string | null, depth: number) {
    const childSystems = childrenOf.get(systemId) ?? []
    const childFiles   = filesOf.get(systemId) ?? []
    const childInfra   = systemId === null ? infraNodes : []

    // Bottom-up: layout children before the parent
    for (const cs of childSystems) layoutNode(cs.id, depth + 1)

    // Empty system - minimum single-cell placeholder
    if (childSystems.length === 0 && childFiles.length === 0 && childInfra.length === 0) {
      if (systemId !== null) {
        const d = Math.max(0, depth)
        computedSizes.set(systemId, { w: containerW(1, d), h: containerH(1, d) })
      }
      return
    }

    if (systemId === null) {
      // Populate computedSizes for root files
      for (const f of childFiles) {
        const fsz = fileNodeSize(0)
        computedSizes.set(f.id, { w: fsz.w, h: fsz.h })
      }

      // Root canvas: check if we should keep user-defined positions
      const rootItems = [
        ...childSystems.map(s => ({ id: s.id })),
        ...childFiles.map(f => ({ id: f.id })),
        ...childInfra.map(i => ({ id: i.id })),
      ]

      if (!isTidy) {
        // Keep existing/db positions
        for (const item of rootItems) {
          const ext = existingMap.get(item.id)
          const sz = computedSizes.get(item.id) ?? { w: 400, h: 300 }
          let x = 0, y = 0
          if (ext?.position?.x !== undefined && ext?.position?.y !== undefined) {
            x = ext.position.x
            y = ext.position.y
          } else {
            const sys = systems.find(s => s.id === item.id)
            if (sys && (sys.positionX !== 0 || sys.positionY !== 0)) {
              x = sys.positionX
              y = sys.positionY
            } else {
              const file = files.find(f => f.id === item.id)
              if (file && (file.positionX !== 0 || file.positionY !== 0)) {
                x = file.positionX
                y = file.positionY
              } else {
                const inf = infraNodes.find(i => i.id === item.id)
                if (inf && (inf.positionX !== 0 || inf.positionY !== 0)) {
                  x = inf.positionX
                  y = inf.positionY
                }
              }
            }
          }
          computedPositions.set(item.id, { x, y, w: sz.w, h: sz.h })
        }
        return
      }

      // Tidy layout: arrange top-level nodes using force-directed layout + overlap resolution
      // Sort root items deterministically by static UUID to ensure consistent starting states without alphabetical bias
      rootItems.sort((a, b) => a.id.localeCompare(b.id))
      const rootIds = rootItems.map(item => item.id)
      const N = rootIds.length

      if (N === 1) {
        const id = rootIds[0]
        const sz = computedSizes.get(id) ?? { w: 400, h: 300 }
        computedPositions.set(id, { x: 0, y: 0, w: sz.w, h: sz.h })
        return
      }

      if (N > 1) {
        const positions = new Map<string, { x: number; y: number }>()

        // Initialize positions in a circle (always start from the circle for a clean, deterministic tidy)
        const radius = Math.max(400, N * 120)
        rootIds.forEach((id, idx) => {
          const angle = (2 * Math.PI * idx) / N
          const x = radius * Math.cos(angle)
          const y = radius * Math.sin(angle)
          positions.set(id, { x, y })
        })

        // Coupling weight matrix
        const weights = new Map<string, number>()
        const getWeight = (id1: string, id2: string) => {
          const key = id1 < id2 ? `${id1}::${id2}` : `${id2}::${id1}`
          return weights.get(key) ?? 0
        }
        for (const dep of dependencies) {
          const rSrc = rootParentOf.get(dep.src)
          const rDst = rootParentOf.get(dep.dst)
          if (rSrc && rDst && rSrc !== rDst && rootIds.includes(rSrc) && rootIds.includes(rDst)) {
            const key = rSrc < rDst ? `${rSrc}::${rDst}` : `${rDst}::${rSrc}`
            weights.set(key, (weights.get(key) ?? 0) + 1)
          }
        }

        // Force simulation parameters
        const ITERATIONS = 200
        const K_REP = 1200000 // Repulsion force constant
        const K_ATT = 0.08    // Attraction spring constant
        const K_GRAV = 0.8 / N + 0.01 // Center gravity force (scales with node count)
        const cooling = 0.98  // Slower cooling rate for stable migration
        let temp = 150.0      // Annealing temperature starting value

        for (let step = 0; step < ITERATIONS; step++) {
          const forces = new Map<string, { fx: number; fy: number }>()
          rootIds.forEach(id => forces.set(id, { fx: 0, fy: 0 }))

          // Repulsion
          for (let i = 0; i < N; i++) {
            const idA = rootIds[i]
            const posA = positions.get(idA)!
            for (let j = i + 1; j < N; j++) {
              const idB = rootIds[j]
              const posB = positions.get(idB)!
              const dx = posB.x - posA.x
              const dy = posB.y - posA.y
              const distSq = dx * dx + dy * dy
              const dist = Math.sqrt(distSq) || 0.1

              const force = K_REP / (distSq + 2000)
              const fx = (dx / dist) * force
              const fy = (dy / dist) * force

              forces.get(idA)!.fx -= fx
              forces.get(idA)!.fy -= fy
              forces.get(idB)!.fx += fx
              forces.get(idB)!.fy += fy
            }
          }

          // Attraction
          for (let i = 0; i < N; i++) {
            const idA = rootIds[i]
            const posA = positions.get(idA)!
            for (let j = i + 1; j < N; j++) {
              const idB = rootIds[j]
              const posB = positions.get(idB)!
              const w = getWeight(idA, idB)
              if (w > 0) {
                const dx = posB.x - posA.x
                const dy = posB.y - posA.y
                const dist = Math.sqrt(dx * dx + dy * dy) || 0.1

                const wFactor = Math.min(6, w)
                const force = K_ATT * wFactor * dist
                const fx = (dx / dist) * force
                const fy = (dy / dist) * force

                forces.get(idA)!.fx += fx
                forces.get(idA)!.fy += fy
                forces.get(idB)!.fx -= fx
                forces.get(idB)!.fy -= fy
              }
            }
          }

          // Center gravity and move nodes
          rootIds.forEach(id => {
            const pos = positions.get(id)!
            const force = forces.get(id)!

            force.fx -= pos.x * K_GRAV
            force.fy -= pos.y * K_GRAV

            const fDist = Math.hypot(force.fx, force.fy) || 0.1
            const disp = Math.min(temp, fDist)
            pos.x += (force.fx / fDist) * disp
            pos.y += (force.fy / fDist) * disp
          })

          temp *= cooling
        }

        // Compact the settled cloud toward an even spread. Dependency chains
        // elongate the simulation into a strip; squeezing the long axis back
        // to the cloud's geometric-mean spread (never stretching the short
        // one) keeps neighborhoods intact while the overlap resolver below
        // re-spreads nodes isotropically into a boxy cluster.
        if (N > 2) {
          let meanX = 0, meanY = 0
          positions.forEach(pos => { meanX += pos.x; meanY += pos.y })
          meanX /= N
          meanY /= N
          let varX = 0, varY = 0
          positions.forEach(pos => {
            varX += (pos.x - meanX) ** 2
            varY += (pos.y - meanY) ** 2
          })
          const spreadX = Math.sqrt(varX / N)
          const spreadY = Math.sqrt(varY / N)
          if (spreadX > 1 && spreadY > 1) {
            const target = Math.sqrt(spreadX * spreadY)
            const squeezeX = Math.max(0.35, Math.min(1, target / spreadX))
            const squeezeY = Math.max(0.35, Math.min(1, target / spreadY))
            positions.forEach(pos => {
              pos.x = meanX + (pos.x - meanX) * squeezeX
              pos.y = meanY + (pos.y - meanY) * squeezeY
            })
          }
        }

        // Bounding-box overlap resolution
        const overlapPadding = BASE_FILE_W * 0.8
        for (let pass = 0; pass < 50; pass++) {
          let resolvedAny = false
          for (let i = 0; i < N; i++) {
            const idA = rootIds[i]
            const posA = positions.get(idA)!
            const szA = computedSizes.get(idA) ?? { w: 400, h: 300 }

            const wA = szA.w + overlapPadding
            const hA = szA.h + overlapPadding
            const cxA = posA.x + wA / 2
            const cyA = posA.y + hA / 2

            for (let j = i + 1; j < N; j++) {
              const idB = rootIds[j]
              const posB = positions.get(idB)!
              const szB = computedSizes.get(idB) ?? { w: 400, h: 300 }

              const wB = szB.w + overlapPadding
              const hB = szB.h + overlapPadding
              const cxB = posB.x + wB / 2
              const cyB = posB.y + hB / 2

              const minDistanceX = (wA + wB) / 2
              const actualDistanceX = Math.abs(cxB - cxA)
              const overlapX = minDistanceX - actualDistanceX

              const minDistanceY = (hA + hB) / 2
              const actualDistanceY = Math.abs(cyB - cyA)
              const overlapY = minDistanceY - actualDistanceY

              if (overlapX > 0 && overlapY > 0) {
                resolvedAny = true
                if (overlapX < overlapY) {
                  const pushX = overlapX / 2
                  const dirX = cxB > cxA ? 1 : -1
                  posA.x -= pushX * dirX
                  posB.x += pushX * dirX
                } else {
                  const pushY = overlapY / 2
                  const dirY = cyB > cyA ? 1 : -1
                  posA.y -= pushY * dirY
                  posB.y += pushY * dirY
                }
              }
            }
          }
          if (!resolvedAny) break
        }

        // Commit final positions
        rootIds.forEach(id => {
          const pos = positions.get(id)!
          const sz = computedSizes.get(id) ?? { w: 400, h: 300 }
          computedPositions.set(id, { x: pos.x, y: pos.y, w: sz.w, h: sz.h })
        })
      }
      return
    }

    // Non-root: strict grid layout using the uniform-gap formula.
    // Cell size at this depth = fileNodeSize(depth).
    // Container: n*cell + (n+1)*gap in both directions.
    const d   = Math.max(0, depth)
    const fsz = fileNodeSize(d)

    const items = [
      ...childSystems.map(c => ({ id: c.id, type: 'system' as const, w: 0, h: 0, wUnits: 1, hUnits: 1 })),
      ...childFiles.map(f => ({ id: f.id, type: 'file'   as const, w: 0, h: 0, wUnits: 1, hUnits: 1 })),
    ].sort((a, b) => getSortKey(a.id) - getSortKey(b.id))

    for (const item of items) {
      if (item.type === 'system') {
        const sz = computedSizes.get(item.id) ?? { w: containerW(1, d + 1), h: containerH(1, d + 1) }
        item.wUnits = wUnitsFor(sz.w, d)
        item.hUnits = hUnitsFor(sz.h, d)
        item.w = sz.w
        item.h = sz.h
      } else {
        item.w = fsz.w
        item.h = fsz.h
        item.wUnits = 1
        item.hUnits = 1
      }
    }

    if (!isTidy) {
      // 1. Snapped grid placement based on existing positions
      let maxColUsed = 1
      let maxRowUsed = 1
      const occupiedCells = new Set<string>()

      for (const item of items) {
        let x = 0, y = 0
        const ext = existingMap.get(item.id)
        if (ext?.position?.x !== undefined && ext?.position?.y !== undefined) {
          x = ext.position.x
          y = ext.position.y
        } else {
          if (item.type === 'system') {
            const sys = systems.find(s => s.id === item.id)
            x = sys?.positionX ?? 0
            y = sys?.positionY ?? 0
          } else {
            const file = files.find(f => f.id === item.id)
            x = file?.positionX ?? 0
            y = file?.positionY ?? 0
          }
        }

        const gap = gridGap(d)
        const cw = fsz.w
        const ch = fsz.h
        const col = Math.max(0, Math.round((x - gap) / (cw + gap)))
        const row = Math.max(0, Math.round((y - gap) / (ch + gap)))

        // Check if this block is free
        let fits = true
        for (let c = col; c < col + item.wUnits; c++) {
          for (let r = row; r < row + item.hUnits; r++) {
            if (occupiedCells.has(`${c}-${r}`)) {
              fits = false
              break
            }
          }
          if (!fits) break
        }

        let foundCol = col
        let foundRow = row

        if (!fits) {
          let found = false
          // Spiral search up to radius 15
          for (let r_limit = 1; r_limit <= 15; r_limit++) {
            for (let dx = -r_limit; dx <= r_limit; dx++) {
              for (let dy = -r_limit; dy <= r_limit; dy++) {
                if (Math.abs(dx) !== r_limit && Math.abs(dy) !== r_limit) continue
                const c = col + dx
                const r = row + dy
                if (c < 0 || r < 0) continue

                let possible = true
                for (let cc = c; cc < c + item.wUnits; cc++) {
                  for (let rr = r; rr < r + item.hUnits; rr++) {
                    if (occupiedCells.has(`${cc}-${rr}`)) {
                      possible = false
                      break
                    }
                  }
                  if (!possible) break
                }
                if (possible) {
                  foundCol = c
                  foundRow = r
                  found = true
                  break
                }
              }
              if (found) break
            }
            if (found) break
          }
        }

        const snapX = cellX(foundCol, d)
        const snapY = cellY(foundRow, d)

        computedPositions.set(item.id, { x: snapX, y: snapY, w: item.w, h: item.h })
        if (item.type === 'system') {
          computedSizes.set(item.id, { w: item.w, h: item.h })
        }

        // Mark cells as occupied
        for (let c = foundCol; c < foundCol + item.wUnits; c++) {
          for (let r = foundRow; r < foundRow + item.hUnits; r++) {
            occupiedCells.add(`${c}-${r}`)
          }
        }

        maxColUsed = Math.max(maxColUsed, foundCol + item.wUnits)
        maxRowUsed = Math.max(maxRowUsed, foundRow + item.hUnits)
      }

      const totalW = containerW(maxColUsed, d)
      const totalH = containerH(maxRowUsed, d)
      computedSizes.set(systemId, { w: totalW, h: totalH })
    } else {
      // 2. Auto packing: organic cluster with per-item breathing room.
      const packed = packFrame(
        items.map(item => ({ id: item.id, width: item.w, height: item.h })),
        { baseGap: FRAME_ITEM_GAP },
      )
      // The top inset is the tab band, not the plain gap. This used to place
      // the first row at `gap` from the frame's top border on every side
      // equally, which only cleared the tab because the old gap happened to be
      // about as tall as it; at depth it did not.
      let insets = frameContentInsets(420, Math.max(0, d))
      for (let round = 0; round < 4; round++) {
        insets = frameContentInsets(packed.height + insets.top + insets.bottom, Math.max(0, d))
      }
      for (const item of items) {
        const position = packed.positions.get(item.id)!
        computedPositions.set(item.id, { x: insets.left + position.x, y: insets.top + position.y, w: item.w, h: item.h })
        if (item.type === 'system') computedSizes.set(item.id, { w: item.w, h: item.h })
      }
      computedSizes.set(systemId, {
        w: packed.width + insets.left + insets.right,
        h: packed.height + insets.top + insets.bottom,
      })
    }
  }

  layoutNode(null, -1)
  return computedPositions
}

// ─── Node data types ───────────────────────────────────────────────────────

export interface SystemNodeData {
  id: string
  name: string
  source: DbSystem['source']
  color: string
  colorRgb: string
  description: string | null
  agentNotes: string | null
  depth: number
  /** Every direct child descriptor, regardless of type, counted exactly once. */
  directChildCount: number
  currentZoom: number
  isChild: boolean
  childrenVisible: number  // 0–1 continuous alpha, not boolean
  selfScale?: number
  selfBlur?: number
  isDropTarget?: boolean
  onResizeStart?: (params: NodeResizeParams) => void
  onResizeEnd?: (params: NodeResizeParams) => void
  onRename?: (name: string) => void
  umlKind?: PlannedNodeKind
  umlMetadata?: PlannedNodeMetadata
  onUmlMetadataChange?: (metadata: PlannedNodeMetadata) => void
  // Drop-target grid overlay
  nodeW?: number
  nodeH?: number
  gridCellW?: number
  gridCellH?: number
  gridGap?: number
  occupiedCells?: Set<string>
  snapPreview?: { col: number; row: number; wUnits: number; hUnits: number } | null
  previewOffset?: { x: number; y: number } | null   // pixel offset showing predicted post-drop position
  frameScale?: number
  worldScale?: number
  minResizeWidth?: number
  minResizeHeight?: number
  presentationBaseWidth?: number
  presentationBaseHeight?: number
}

export interface FileNodeData {
  id: string
  label: string
  relPath: string
  language: string
  lineCount: number
  churnScore: number
  /** Semantic role: '' plain | 'class' (class-first header) | 'cylinder' | 'hexagon'. */
  shape: '' | 'class' | 'cylinder' | 'hexagon'
  /** Class-first title when shape==='class'. */
  displayName: string
  depth: number
  currentZoom: number
  childrenVisible: number
  worldScale: number  // fileNodeSize(parentDepth).w / BASE_FILE_W - drives proportional font/padding
  previewOffset?: { x: number; y: number } | null   // pixel offset showing predicted post-drop position
  frameScale?: number
  /** Optional synthetic symbols supplied by a sheet-local planned file/class. */
  symbols?: Array<{ name: string; kind: string; lineStart: number; lineEnd: number }>
  onRename?: (name: string) => void
  onLanguageChange?: (language: string) => void
  onResizeStart?: (params: NodeResizeParams) => void
  onResizeEnd?: (params: NodeResizeParams) => void
  onSymbolsChange?: (symbols: Array<{ name: string; kind: string; lineStart: number; lineEnd: number }>) => void
  umlKind?: PlannedNodeKind
  umlMetadata?: PlannedNodeMetadata
  onUmlMetadataChange?: (metadata: PlannedNodeMetadata) => void
}

export interface InfraNodeData {
  id: string
  label: string
  name: string
  /** @deprecated superseded by category/provider/service */
  infraType: string
  category: string
  provider: string
  service: string
  subtype: string
  status: string
  umlKind?: PlannedNodeKind
  umlMetadata?: PlannedNodeMetadata
  onRename?: (name: string) => void
  onChooseInfra?: () => void
  onUmlMetadataChange?: (metadata: PlannedNodeMetadata) => void
  onResizeStart?: (params: NodeResizeParams) => void
  onResizeEnd?: (params: NodeResizeParams) => void
  frameScale?: number
  worldScale?: number
}

// ─── Layout engine ─────────────────────────────────────────────────────────

/**
 * Materialize the Floor as nested coordinate frames. Unlike the legacy layout,
 * this never quantizes authored positions, displaces siblings, or derives
 * visual containment from a drop's semantic side effects.
 */
/**
 * Placements this session has already decided for nodes that have no persisted
 * row, keyed by node id.
 *
 * Without it the projection is NOT a pure function of persisted state: a
 * priority-2 node's position comes from `placeIncoming`, scored against the
 * live bounds and centroid of everything already registered in its frame. So
 * changing ONE node's geometry - any drop writes a row - shifts that centroid
 * and re-places every unpersisted sibling, which then shifts it again for the
 * next one. Dragging a single node made unrelated nodes scatter.
 *
 * Root-level unclassified files never persist at all (deliberately: pinning
 * them would block live classification from moving them into their system), so
 * for those the churn was permanent rather than transient.
 *
 * A remembered placement is dropped as soon as the node gains a persisted row
 * or moves to a different parent, so this only ever supplies the FIRST answer.
 */
export interface GeneratedPlacement {
  parentId: string | null
  x: number
  y: number
}

/**
 * A repository/proposal refresh may finish while a pointer gesture is still
 * authoritative. Reproject the new semantic scene, but retain geometry for
 * the exact nodes whose active resize has already changed. Without this merge,
 * a delayed persistence response paints the previous width/position for one
 * frame and the next pointer sample paints the live size again.
 */
function preserveActiveResizeGeometry(
  projected: Node[],
  interactive: readonly Node[],
  affectedNodeIds: ReadonlySet<string>,
): Node[] {
  if (affectedNodeIds.size === 0) return projected
  const interactiveById = new Map(interactive.map(node => [node.id, node]))
  return projected.map(node => {
    if (!affectedNodeIds.has(node.id)) return node
    const current = interactiveById.get(node.id)
    // Pointer ownership covers the whole presentation node, not just its box.
    // Combining current geometry with freshly projected data still remounted
    // the inner system presentation during review responses (typography,
    // presentation scale, and chrome could restamp while the outline stayed
    // fixed). Keep the exact interactive node until pointer-up, then the
    // projection revision below applies the newest canonical data once.
    return current ?? node
  })
}

function buildFloorFrameLayout(
  systems: DbSystem[],
  files: DbFile[],
  infraNodes: DbInfraNode[],
  dependencies: DbDependency[],
  floorLayouts: FloorLayout[],
  currentZoom: number,
  generatedPlacements: Map<string, GeneratedPlacement> = new Map(),
): {
  rfNodes: Node[]
  rfEdges: Edge[]
  generatedLayoutNodeIds: Set<string>
  resizedContainerIds: Set<string>
} {
  const systemsById = new Map(systems.map(system => [system.id, system]))
  const filesById = new Map(files.map(file => [file.id, file]))
  const infraById = new Map(infraNodes.map(infra => [infra.id, infra]))
  const layoutsById = new Map(floorLayouts.map(layout => [layout.nodeId, layout]))
  const initialGraphLayout = floorLayouts.length === 0
    ? runAlternateAxisLayout(systems, files, infraNodes, dependencies, new Map())
    : null
  const nodeTypes = new Map<string, FloorNodeType>([
    ...systems.map(system => [system.id, 'system'] as const),
    ...files.map(file => [file.id, 'file'] as const),
    ...infraNodes.map(infra => [infra.id, 'infra'] as const),
  ])

  const parentById = new Map<string, string | null>()
  for (const system of systems) parentById.set(system.id, layoutsById.has(system.id) ? layoutsById.get(system.id)!.parentNodeId : system.parentId)
  for (const file of files) parentById.set(file.id, layoutsById.has(file.id) ? layoutsById.get(file.id)!.parentNodeId : file.systemId)
  for (const infra of infraNodes) parentById.set(infra.id, layoutsById.get(infra.id)?.parentNodeId ?? null)

  // Invalid/missing parents and cycles degrade to root instead of making the
  // graph disappear. The API rejects new invalid writes; this protects legacy DBs.
  for (const [id, parentId] of parentById) {
    if (parentId && (!nodeTypes.has(parentId) || nodeTypes.get(parentId) === 'file')) parentById.set(id, null)
    const visited = new Set<string>([id])
    let current = parentById.get(id) ?? null
    while (current) {
      if (visited.has(current)) { parentById.set(id, null); break }
      visited.add(current)
      current = parentById.get(current) ?? null
    }
  }

  const siblingsByParent = new Map<string | null, string[]>()
  for (const [id, parentId] of parentById) {
    const siblings = siblingsByParent.get(parentId) ?? []
    siblings.push(id)
    siblingsByParent.set(parentId, siblings)
  }
  for (const siblings of siblingsByParent.values()) siblings.sort()

  const geometryById = new Map<string, ReturnType<typeof normalizeGeometry>>()
  const occupiedByParent = new Map<string | null, Array<{ x: number; y: number; width: number; height: number }>>()
  const defaultSize = (id: string) => {
    const system = systemsById.get(id)
    if (system) return { width: system.width ?? 620, height: system.height ?? 420 }
    const file = filesById.get(id)
    if (file) return { width: file.width ?? BASE_FILE_W, height: file.height ?? BASE_FILE_H }
    const infra = infraById.get(id)
    return infra?.category === 'platform' ? { width: 760, height: 520 } : { width: 260, height: 160 }
  }

  const depthCache = new Map<string, number>()
  const depthOf = (id: string): number => {
    const cached = depthCache.get(id)
    if (cached !== undefined) return cached
    const parentId = parentById.get(id) ?? null
    const value = parentId ? depthOf(parentId) + 1 : 0
    depthCache.set(id, value)
    return value
  }

  /**
   * Where a child may sit inside a frame. One helper so incremental placement,
   * fresh packing and drop placement cannot drift apart on the tab allowance.
   */
  const insetsOf = (containerId: string) => {
    const container = geometryById.get(containerId)
    const base = defaultSize(containerId)
    return frameContentInsets(container?.height ?? base.height, depthOf(containerId))
  }

  // A genuinely fresh Floor is packed bottom-up: deepest frames first, each
  // frame sized from its packed contents, so a parent can never be smaller
  // than what it holds and post-hoc growth never creates sibling overlap.
  const freshPackPositions = new Map<string, { x: number; y: number }>()
  const freshPackSizes = new Map<string, { width: number; height: number }>()
  if (initialGraphLayout) {
    const sizeOf = (id: string) => freshPackSizes.get(id) ?? defaultSize(id)
    const packedFrames = new Set<string>()
    const packContainer = (containerId: string) => {
      if (packedFrames.has(containerId)) return
      packedFrames.add(containerId)
      const children = siblingsByParent.get(containerId) ?? []
      for (const childId of children) if (siblingsByParent.has(childId)) packContainer(childId)
      if (children.length === 0) return
      const packed = packFrame(
        children.map(childId => ({ id: childId, ...sizeOf(childId) })),
        { baseGap: FRAME_ITEM_GAP },
      )
      // The title chrome scales with the frame's presentation scale, and the
      // frame's size depends on the header in turn - iterate to the fixed
      // point so children never start under the rendered title band.
      const base = defaultSize(containerId)
      const depth = depthOf(containerId)
      let insets = frameContentInsets(420, depth)
      for (let round = 0; round < 4; round++) {
        insets = frameContentInsets(Math.max(220, packed.height + insets.top + insets.bottom), depth)
      }
      for (const childId of children) {
        const position = packed.positions.get(childId)!
        freshPackPositions.set(childId, {
          x: insets.left + position.x,
          y: insets.top + position.y,
        })
      }
      freshPackSizes.set(containerId, {
        width: Math.max(320, packed.width + insets.left + insets.right),
        height: Math.max(220, packed.height + insets.top + insets.bottom),
      })
    }
    for (const parentKey of siblingsByParent.keys()) {
      if (parentKey) packContainer(parentKey)
    }
  }

  const generatedLayoutNodeIds = new Set<string>()
  const placementCandidates = [...parentById].map(([id, parentId]) => {
    const layout = layoutsById.get(id)
    const fallback = defaultSize(id)
    const semantic = systemsById.get(id) ?? filesById.get(id) ?? infraById.get(id)
    const initialPosition = parentId === null ? initialGraphLayout?.get(id) : undefined
    let x = layout?.positionX ?? initialPosition?.x ?? semantic?.positionX ?? 0
    let y = layout?.positionY ?? initialPosition?.y ?? semantic?.positionY ?? 0
    const fresh = freshPackPositions.get(id)
    if (!layout && x === 0 && y === 0 && fresh) {
      x = fresh.x
      y = fresh.y
    }
    if (!layout) generatedLayoutNodeIds.add(id)
    return {
      id,
      parentId,
      layout,
      fallback,
      x,
      y,
      placementPriority: layout ? 0 as const : (fresh || x !== 0 || y !== 0) ? 1 as const : 2 as const,
    }
  })

  // Database/API order is not spatial order. Register every persisted sibling
  // first so an incoming system/file cannot be placed underneath a persisted
  // node that happens to appear later in the snapshot.
  for (const candidate of orderFramePlacementCandidates(placementCandidates)) {
    const { id, parentId, layout, fallback } = candidate
    let { x, y } = candidate
    const occupied = occupiedByParent.get(parentId) ?? []
    if (candidate.placementPriority === 2) {
      // Decide this ONCE. Re-deriving it on every projection made a node's
      // position depend on the current geometry of everything around it, so a
      // single drop scattered every unpersisted node in the frame.
      const remembered = generatedPlacements.get(id)
      if (remembered && remembered.parentId === parentId) {
        x = remembered.x
        y = remembered.y
      } else {
        // A node indexed after the initial layout was persisted clusters in
        // beside its siblings instead of landing on a blind grid.
        const spot = placeIncoming(
          { id, width: fallback.width, height: fallback.height },
          occupied,
          {
            // Same clearance a drop or a repack would use, so a node that
            // arrives by indexing sits exactly as tightly as one placed by hand.
            baseGap: parentId ? FRAME_ITEM_GAP : FRAME_ROOT_GAP,
            origin: parentId
              ? { x: insetsOf(parentId).left, y: insetsOf(parentId).top }
              : { x: 80, y: 80 },
          },
        )
        x = spot.x
        y = spot.y
        generatedPlacements.set(id, { parentId, x, y })
      }
    } else if (generatedPlacements.has(id)) {
      // It has real geometry now - persisted, semantic, or freshly packed - so
      // the remembered guess must not outlive it.
      generatedPlacements.delete(id)
    }
    const freshSize = freshPackSizes.get(id)
    const geometry = normalizeGeometry({
      x, y,
      width: layout?.width ?? freshSize?.width ?? fallback.width,
      height: layout?.height ?? freshSize?.height ?? fallback.height,
      scale: layout?.scale ?? 1,
      interiorScale: layout?.interiorScale ?? 1,
    }, fallback)
    geometryById.set(id, geometry)
    occupied.push({ x: geometry.x, y: geometry.y, width: geometry.width * geometry.scale, height: geometry.height * geometry.scale })
    occupiedByParent.set(parentId, occupied)
  }

  const resizedContainerIds = new Set<string>()
  // Initial-index/legacy containers auto-fit their direct children. Persisted
  // containers retain authored dimensions as a minimum, but may grow when a
  // newly indexed child would otherwise sit outside their frame.
  for (const [containerId, children] of siblingsByParent) {
    if (!containerId) continue
    const isContainer = systemsById.has(containerId) || infraById.get(containerId)?.category === 'platform'
    if (!isContainer || children.length === 0) continue
    const hasIncomingChild = children.some(childId => !layoutsById.has(childId))
    if (layoutsById.has(containerId) && !hasIncomingChild) continue
    const container = geometryById.get(containerId)
    if (!container) continue
    const childFrames = children.flatMap(childId => {
      const child = geometryById.get(childId)
      return child ? [child] : []
    })
    const fitted = growFrameToContainChildren(container, childFrames, insetsOf(containerId).right)
    geometryById.set(containerId, fitted)
    if (fitted.width !== container.width || fitted.height !== container.height) {
      resizedContainerIds.add(containerId)
    }
  }

  // The relationship-aware initializer was historically sized for the legacy
  // grid renderer. Resolve its root collisions again using the materialized
  // freeform frame bounds while retaining the force-directed neighborhood.
  if (initialGraphLayout) {
    const rootIds = siblingsByParent.get(null) ?? []
    const padding = 72
    for (let pass = 0; pass < 100; pass++) {
      let moved = false
      for (let leftIndex = 0; leftIndex < rootIds.length; leftIndex++) {
        const left = geometryById.get(rootIds[leftIndex])!
        const leftWidth = left.width * left.scale
        const leftHeight = left.height * left.scale
        for (let rightIndex = leftIndex + 1; rightIndex < rootIds.length; rightIndex++) {
          const right = geometryById.get(rootIds[rightIndex])!
          const rightWidth = right.width * right.scale
          const rightHeight = right.height * right.scale
          const overlapX = Math.min(left.x + leftWidth + padding, right.x + rightWidth + padding) - Math.max(left.x, right.x)
          const overlapY = Math.min(left.y + leftHeight + padding, right.y + rightHeight + padding) - Math.max(left.y, right.y)
          if (overlapX <= 0 || overlapY <= 0) continue
          moved = true
          if (overlapX < overlapY) {
            const direction = right.x + rightWidth / 2 >= left.x + leftWidth / 2 ? 1 : -1
            left.x -= direction * overlapX / 2
            right.x += direction * overlapX / 2
          } else {
            const direction = right.y + rightHeight / 2 >= left.y + leftHeight / 2 ? 1 : -1
            left.y -= direction * overlapY / 2
            right.y += direction * overlapY / 2
          }
        }
      }
      if (!moved) break
    }
  }

  const depthById = new Map<string, number>()
  const worldScaleById = new Map<string, number>()
  const contentScaleById = new Map<string, number>()
  // A frame's own world scale and the scale it hands to its children are two
  // different numbers. They differ exactly when a container compresses its
  // interior, which is what lets that compression leave the container's own
  // size - and everything derived from it - completely untouched.
  const resolveFrame = (id: string): { depth: number; worldScale: number; contentScale: number } => {
    const cachedDepth = depthById.get(id)
    const cachedScale = worldScaleById.get(id)
    const cachedContent = contentScaleById.get(id)
    if (cachedDepth !== undefined && cachedScale !== undefined && cachedContent !== undefined) {
      return { depth: cachedDepth, worldScale: cachedScale, contentScale: cachedContent }
    }
    const parentId = parentById.get(id) ?? null
    const parent = parentId ? resolveFrame(parentId) : { depth: -1, worldScale: 1, contentScale: 1 }
    const geometry = geometryById.get(id)
    const worldScale = parent.contentScale * (geometry?.scale ?? 1)
    const result = {
      depth: parent.depth + 1,
      worldScale,
      contentScale: worldScale * (geometry?.interiorScale ?? 1),
    }
    depthById.set(id, result.depth)
    worldScaleById.set(id, result.worldScale)
    contentScaleById.set(id, result.contentScale)
    return result
  }

  const descriptors: FloorSceneDescriptor[] = [...parentById.keys()].map(id => {
    const resolved = resolveFrame(id)
    return { id, nodeType: nodeTypes.get(id)!, parentId: parentById.get(id) ?? null, geometry: geometryById.get(id)!, ...resolved }
  }).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))

  const rfNodes = projectFloorNodes({
    systems,
    files,
    infraNodes,
    descriptors,
    siblingsByParent,
    geometryById,
    worldScaleById,
    contentScaleById,
    currentZoom,
  })
  return { rfNodes, rfEdges: [], generatedLayoutNodeIds, resizedContainerIds }
}

function ZoomIndicator() {
  const { zoom } = useViewport()
  return (
    <div className="axiom-zoom-indicator" aria-label={`Zoom ${zoom.toFixed(2)}x`}>
      <span>Zoom:</span>
      <strong>{zoom.toFixed(2)}x</strong>
    </div>
  )
}

// ─── Main component ────────────────────────────────────────────────────────

interface AxiomCanvasProps {
  readOnly?: boolean
  reviewScene?: {
    id: string
    workspaceId: string
    systems: DbSystem[]
    files: DbFile[]
    /** Every indexed file, so the bins can see past what this proposal claimed. */
    binFiles?: readonly DbFile[]
    /** Real file ids this proposal places, by which the bins judge "has a home". */
    placedBinFileIds?: ReadonlySet<string>
    floorLayouts: FloorLayout[]
    editableNodeIds: ReadonlySet<string>
    selectedNodeId: string | null
    onSelectNode: (nodeId: string | null) => void
    onPreviewLayouts: (layouts: Array<Omit<FloorLayout, 'workspaceId' | 'updatedAt'>>) => void
    onSaveLayouts: (layouts: Array<Omit<FloorLayout, 'workspaceId' | 'updatedAt'>>) => Promise<void>
  }
  /**
   * The unsorted bin, rendered as a real canvas of real file nodes.
   *
   * Deliberately has no layout: the bin is a waiting room, so its contents pack
   * themselves fresh every time rather than remembering an arrangement nobody
   * asked to keep. Nothing here ever writes a layout row.
   */
  binScene?: {
    workspaceId: string
    files: readonly DbFile[]
  }
}

/**
 * Where a gesture ended, mouse or touch. A released touch reports its position
 * on `changedTouches` and leaves `touches` empty, so reading the event blindly
 * loses the drop point on exactly the gesture that needs it.
 */
function rectContains(element: Element | null, point: { x: number; y: number }): boolean {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  return point.x >= rect.left && point.x <= rect.right
    && point.y >= rect.top && point.y <= rect.bottom
}

function pointerOf(event: React.MouseEvent | MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('clientX' in event) return { x: event.clientX, y: event.clientY }
  const touch = event.changedTouches[0]
  return touch ? { x: touch.clientX, y: touch.clientY } : null
}

/**
 * Bin drag diagnostics. Off by default; turn them on from the devtools console
 * with `window.__axiomBinDragDebug = true` and repeat the gesture - read at
 * call time so no rebuild is needed.
 */
function binDragDebug(): boolean {
  return (window as unknown as { __axiomBinDragDebug?: boolean }).__axiomBinDragDebug !== false
}

/** Stable identities, so the bin canvas does not rebuild its layout every render. */
const emptyBinSystems: DbSystem[] = []
/** The bin never persists geometry, so it always packs from nothing. */
const emptyBinLayouts: FloorLayout[] = []

export function AxiomCanvas({ readOnly = false, reviewScene, binScene }: AxiomCanvasProps = {}) {
  const reviewMode = reviewScene !== undefined
  const binMode = binScene !== undefined
  // Both modes swap the scene data and cut every live subscription. The Floor
  // is the only surface that owns the workspace's real state.
  const isolatedScene = reviewMode || binMode
  const reviewEditableNodeIds = reviewScene?.editableNodeIds
  const previewReviewLayouts = reviewScene?.onPreviewLayouts
  const saveReviewLayouts = reviewScene?.onSaveLayouts
  const {
    systems: liveSystems, files: liveFiles, infraNodes: liveInfraNodes,
    dependencies: liveDependencies, floorLayouts: liveFloorLayouts,
    selectedNodeId: liveSelectedNodeId, infraPickerNodeId, selectionMode,
    activeTrace: liveActiveTrace, runtimeNodes: liveRuntimeNodes,
    dataFlow: liveDataFlow, nodeFx: liveNodeFx, relationshipFx: liveRelationshipFx,
    delta: liveDelta, activeWorkSessions: liveActiveWorkSessions,
    deltaReviewing: liveDeltaReviewing, deltaCursor: liveDeltaCursor,
    agentAttention: liveAgentAttention, isIndexing: liveIsIndexing,
  } = useGraphStore(useShallow(s => ({
    agentAttention:  s.agentAttention,
    delta:           s.delta,
    activeWorkSessions: s.activeWorkSessions,
    deltaReviewing:  s.deltaReviewing,
    deltaCursor:     s.deltaCursor,
    systems:         s.systems,
    files:           s.files,
    infraNodes:      s.infraNodes,
    dependencies:    s.dependencies,
    floorLayouts:    s.floorLayouts,
    selectedNodeId:  s.selectedNodeId,
    infraPickerNodeId: s.infraPickerNodeId,
    selectionMode:   s.selectionMode,
    activeTrace:     s.activeTrace,
    runtimeNodes:    s.runtimeNodes,
    dataFlow:        s.dataFlow,
    nodeFx:          s.nodeFx,
    relationshipFx:  s.relationshipFx,
    isIndexing:       s.isIndexing,
  })))

  // Disabled live-only channels must be referentially stable in review mode.
  // Fresh [] / {} / Map instances on every drag render retriggered layout and
  // projection effects, which then overwrote React Flow's in-flight position
  // with the last persisted frame and made nodes teleport under the pointer.
  const emptyReviewLiveState = useMemo(() => ({
    infraNodes: [] as typeof liveInfraNodes,
    dependencies: [] as typeof liveDependencies,
    activeTrace: [] as typeof liveActiveTrace,
    runtimeNodes: {} as typeof liveRuntimeNodes,
    nodeFx: {} as typeof liveNodeFx,
    relationshipFx: [] as typeof liveRelationshipFx,
    activeWorkSessions: [] as typeof liveActiveWorkSessions,
    // A Record, like the store's own empty value. It was a Map cast to one,
    // which survived only because an empty Map has no enumerable keys and the
    // consumers all early-return on Object.keys(...).length === 0.
    agentAttention: {} as typeof liveAgentAttention,
  }), [])

  // Review and the unsorted bin are data/persistence modes of this component,
  // not other canvases. Every interaction below therefore remains the live
  // Floor implementation - which is the whole point: a file in the bin is a
  // real file node you can zoom into and read, not a lookalike card.
  const systems = binScene ? emptyBinSystems : reviewScene?.systems ?? liveSystems
  const sceneFiles = binScene?.files ?? reviewScene?.files ?? liveFiles
  // The bins draw from the complete indexed population, which is not the same
  // list the canvas draws. In review the scene holds only the files a proposal
  // claimed, so the full set arrives alongside it.
  const binSourceFiles = reviewScene?.binFiles ?? liveFiles
  const reviewPlacedFileIds = reviewScene?.placedBinFileIds
  const floorLayouts = binMode ? emptyBinLayouts : reviewScene?.floorLayouts ?? liveFloorLayouts

  /**
   * Files placed on the Floor by hand while belonging to no system.
   *
   * "Unclassified" covers two different situations and only one of them belongs
   * in a bin: a file nobody has touched is waiting, while a file someone
   * dragged onto the Floor has been put somewhere on purpose. A root layout row
   * is the difference - it exists only because a person made it exist - so it
   * is what separates "on the map, just not in a system" from "still unsorted".
   */
  const looseFileIds = useMemo(() => new Set(
    floorLayouts
      .filter(layout => layout.nodeType === 'file' && layout.containmentKind === 'root')
      .map(layout => layout.nodeId),
  ), [floorLayouts])
  const fileBelongsOnFloor = useCallback(
    (file: DbFile) => !!file.systemId || looseFileIds.has(file.id),
    [looseFileIds],
  )
  const bins = useMemo(() => partitionCanvasFiles(binSourceFiles, {
    hasHome: reviewPlacedFileIds
      ? (file: DbFile) => reviewPlacedFileIds.has(file.id)
      : fileBelongsOnFloor,
  }), [binSourceFiles, reviewPlacedFileIds, fileBelongsOnFloor])

  // An unclassified file only belongs in a bin once there is an architecture to
  // be unclassified FROM. Before anyone has authored one, every file is
  // unplaced - binning them all would empty the map and hide the whole project
  // behind a tray, which is the opposite of "the map is always complete".
  const binsHoldUnclassified = !binMode && systems.length > 0
  const files = useMemo(
    () => binsHoldUnclassified
      ? sceneFiles.filter(file => isCanvasSourceFile(file) && fileBelongsOnFloor(file))
      : sceneFiles.filter(isCanvasSourceFile),
    [sceneFiles, binsHoldUnclassified, fileBelongsOnFloor],
  )
  const infraNodes = isolatedScene ? emptyReviewLiveState.infraNodes : liveInfraNodes
  const dependencies = isolatedScene ? emptyReviewLiveState.dependencies : liveDependencies
  const selectedNodeId = reviewScene?.selectedNodeId ?? liveSelectedNodeId
  const activeTrace = isolatedScene ? emptyReviewLiveState.activeTrace : liveActiveTrace
  const runtimeNodes = isolatedScene ? emptyReviewLiveState.runtimeNodes : liveRuntimeNodes
  const dataFlow = isolatedScene ? null : liveDataFlow
  const nodeFx = isolatedScene ? emptyReviewLiveState.nodeFx : liveNodeFx
  const relationshipFx = isolatedScene ? emptyReviewLiveState.relationshipFx : liveRelationshipFx
  const delta = isolatedScene ? null : liveDelta
  const activeWorkSessions = isolatedScene ? emptyReviewLiveState.activeWorkSessions : liveActiveWorkSessions
  const deltaReviewing = isolatedScene ? false : liveDeltaReviewing
  const deltaCursor = isolatedScene ? 0 : liveDeltaCursor
  const agentAttention = isolatedScene ? emptyReviewLiveState.agentAttention : liveAgentAttention
  const isIndexing = isolatedScene ? false : liveIsIndexing

  const { setLiveSelectedNode, setInspectedNode, setInfraPickerNode, setSelectionMode } = useGraphStore(
    useShallow(s => ({
      setLiveSelectedNode: s.setSelectedNode,
      setInspectedNode: s.setInspectedNode,
      setInfraPickerNode: s.setInfraPickerNode,
      setSelectionMode: s.setSelectionMode,
    }))
  )
  const setSelectedNode = reviewScene?.onSelectNode ?? setLiveSelectedNode
  const currentProject = useGraphStore(s => s.currentProject)
  const { fitView, getViewport, setViewport, getInternalNode, screenToFlowPosition } = useReactFlow()
  const reactFlowStore = useStoreApi()
  // Subscribed rather than read once: the bin button shows whether the reader
  // is open, and a stale read would leave it stuck looking closed.
  const documentsOpen = useGraphStore(state => state.documentsOpen)
  // Semantically hidden descendants are intentionally not mounted. Camera
  // readiness therefore tracks the visible render set rather than waiting for
  // measurements that hidden nodes should never produce.
  const nodesInitialized = useNodesInitialized()
  const livingVisibilityOptions = useMemo(() => {
    const semanticParentById = new Map<string, string | null>()
    const labelById = new Map<string, string>()
    for (const system of systems) {
      semanticParentById.set(system.id, system.parentId ?? null)
      labelById.set(system.id, system.name)
    }
    for (const file of files) {
      semanticParentById.set(file.id, file.systemId ?? null)
      labelById.set(file.id, file.relPath.split('/').pop() ?? file.relPath)
    }
    for (const infra of infraNodes) {
      semanticParentById.set(infra.id, null)
      labelById.set(infra.id, infra.name)
    }
    return { semanticParentById, labelById }
  }, [systems, files, infraNodes])

  const [candidateRfNodes, setRfNodes] = useState<Node[]>([])
  const [rfEdges, setRfEdges] = useState<Edge[]>([])
  const canonicalNodeIds = useMemo(() => new Set([
    ...systems.map(system => system.id),
    ...files.map(file => file.id),
    ...infraNodes.map(infra => infra.id),
  ]), [systems, files, infraNodes])
  const canonicalNodeCount = canonicalNodeIds.size
  const sceneProjectId = binScene ? "bin" : reviewScene?.id ?? currentProject?.id ?? "demo"
  const [reviewReadySceneId, setReviewReadySceneId] = useState<string | null>(null)
  const reviewLayoutReady = !reviewMode || reviewReadySceneId === sceneProjectId
  const classifiedFileCount = useMemo(
    () => files.reduce((count, file) => count + (file.systemId ? 1 : 0), 0),
    [files],
  )
  const deferCanvasMaterialization = shouldDeferCanvasMaterialization({
    isIndexing,
    fileCount: files.length,
    classifiedFileCount,
    systemCount: systems.length,
    floorLayoutCount: floorLayouts.length,
  })
  // Memoized because this object is an effect dependency. Rebuilding it every
  // render restarts the debounce on the blank-canvas recovery below, which can
  // starve that recovery indefinitely during exactly the render storms (a save
  // burst with living flows in flight) that it exists to recover from.
  const candidateSceneIntegrity = useMemo(
    () => inspectFloorScene(candidateRfNodes, canonicalNodeCount, canonicalNodeIds),
    [candidateRfNodes, canonicalNodeCount, canonicalNodeIds],
  )
  const lastHealthySceneRef = useRef<{ projectId: string; nodes: Node[] } | null>(null)
  if (!deferCanvasMaterialization && candidateSceneIntegrity.valid && candidateRfNodes.length > 0) {
    lastHealthySceneRef.current = { projectId: sceneProjectId, nodes: candidateRfNodes }
  }
  const retainedCandidate = lastHealthySceneRef.current?.projectId === sceneProjectId
    ? lastHealthySceneRef.current.nodes
    : null
  // A healthy snapshot from before an index add/delete is not a valid recovery
  // target for the new canonical graph. Reusing it creates a permanent
  // canonical-mismatch loop and leaves deleted nodes interactive.
  const retainedScene = retainedCandidate &&
    retainedCandidate.length === canonicalNodeIds.size &&
    retainedCandidate.every(node => canonicalNodeIds.has(node.id))
    ? retainedCandidate
    : null
  const rfNodes = deferCanvasMaterialization
    ? []
    : !candidateSceneIntegrity.valid && retainedScene?.length
      ? retainedScene
      : candidateRfNodes
  useLayoutEffect(() => {
    if (deferCanvasMaterialization) return
    if (candidateSceneIntegrity.valid || !retainedScene?.length) return
    console.error('[scene-integrity] rejected invalid Floor projection', {
      projectId: sceneProjectId,
      canonicalNodeCount,
      ...candidateSceneIntegrity,
      retainedNodeCount: retainedScene.length,
    })
    // Restore the controlled candidate too, so later interaction changes are
    // based on the valid scene rather than the rejected transient projection.
    sceneSourceRef.current = `integrity-restore:${candidateSceneIntegrity.reason}`
    setRfNodes(retainedScene)
  }, [
    candidateSceneIntegrity.valid,
    candidateSceneIntegrity.reason,
    candidateSceneIntegrity.nodeCount,
    candidateSceneIntegrity.rootCount,
    candidateSceneIntegrity.visibleRootCount,
    candidateSceneIntegrity.invalidNodeIds,
    canonicalNodeCount,
    retainedScene,
    sceneProjectId,
    deferCanvasMaterialization,
  ])
  // Sheet composition also needs the current zoom, so this ref must be
  // initialized before its memoized layout runs.
  const currentZoomRef = useRef(0.5)
  const wheelLatchRef = useRef<{ element: Element; lastEventAt: number } | null>(null)
  // Which code path most recently asked the controlled scene to change. Read by
  // the scene-mutation tracer so a teleporting frame names its own cause.
  const sceneSourceRef = useRef<string>('init')
  const sceneSnapshotRef = useRef<SceneNodeGeometry[]>([])
  // Semantic visibility only changes with zoom - track the last zoom we restamped
  // at so panning (zoom unchanged) never re-renders every node.
  const lastVisibilityZoomRef = useRef(0.5)
  // Live reframing: gently fit the growing graph into view, but yield to the
  // user while they are actively navigating.
  const liveNodeCountRef = useRef(0)
  const lastUserMoveAtRef = useRef(0)
  const cameraFitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingInitialFitProjectRef = useRef<string | null>(null)
  const runningInitialFitProjectRef = useRef<string | null>(null)
  const canvasRootRef = useRef<HTMLDivElement>(null)
  const domSceneRecoveryRef = useRef('')
  const cursorTraceSignatureRef = useRef('')
  const selectedIdsRef = useRef<Set<string>>(new Set())
  // The selection chip used to read `selected` off the projected React Flow
  // nodes, but that projection is rebuilt or restored by several independent
  // paths (layout rebuild, integrity restore, living FX, the zoom pass). Any
  // one of them dropping the flag for a frame made the chip blink out. The
  // authoritative set is selectedIdsRef, so mirror its file subset into state
  // and render the chip from that instead.
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([])
  const [selectionRevision, setSelectionRevision] = useState(0)
  const commitSelection = useCallback((ids: Set<string>) => {
    const previous = selectedIdsRef.current
    const changed = previous.size !== ids.size || [...ids].some(id => !previous.has(id))
    selectedIdsRef.current = ids
    if (changed) setSelectionRevision(revision => revision + 1)
    const currentFileIds = new Set(files.map(file => file.id))
    const next = [...ids].filter(id => currentFileIds.has(id))
    setSelectedFileIds(previous => {
      if (previous.length === next.length && next.every(id => previous.includes(id))) {
        return previous
      }
      return next
    })
  }, [files])
  const timeoutHandlesRef = useRef<Set<number>>(new Set())
  const scheduleTimeout = useCallback((callback: () => void, delay: number) => {
    const handle = window.setTimeout(() => {
      timeoutHandlesRef.current.delete(handle)
      callback()
    }, delay)
    timeoutHandlesRef.current.add(handle)
    return handle
  }, [])
  useEffect(() => () => {
    for (const handle of timeoutHandlesRef.current) window.clearTimeout(handle)
    timeoutHandlesRef.current.clear()
    if (cameraFitTimerRef.current) window.clearTimeout(cameraFitTimerRef.current)
  }, [])
  const queueCameraFit = useCallback((
    delay: number,
    options: { padding: number; duration: number; maxZoom?: number },
  ) => {
    if (cameraFitTimerRef.current) clearTimeout(cameraFitTimerRef.current)
    const runWhenIdle = () => {
      const idleFor = Date.now() - lastUserMoveAtRef.current
      const requiredIdle = 1200
      if (idleFor < requiredIdle) {
        cameraFitTimerRef.current = setTimeout(runWhenIdle, requiredIdle - idleFor)
        return
      }
      cameraFitTimerRef.current = null
      void fitView(options)
    }
    cameraFitTimerRef.current = setTimeout(runWhenIdle, delay)
  }, [fitView])

  /**
   * Moving a node between the Floor and the bin must not move the camera.
   *
   * The live reframe exists for files streaming in from the watcher - the map
   * genuinely growing as code is written. A file crossing between two views of
   * the same workspace is not that: it is one node the user deliberately moved,
   * and reframing on it yanks the view out from under the gesture they are
   * still performing.
   *
   * Both halves matter. The flag stops the next reframe from being scheduled,
   * and the cancel kills one already counting down from an earlier crossing -
   * which is why the camera only jumped on some drops and not others.
   */
  const suppressGrowthFitRef = useRef(false)
  const holdCameraForGesture = useCallback(() => {
    suppressGrowthFitRef.current = true
    if (cameraFitTimerRef.current) {
      clearTimeout(cameraFitTimerRef.current)
      cameraFitTimerRef.current = null
    }
  }, [])
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [sheetDialogOpen, setSheetDialogOpen] = useState(false)
  // ── Sheet overlay (REVISION 2: sheets are layers over the Floor) ─────────
  // The live canvas is the base layer. When a sheet is active: dim non-member
  // live nodes in place (stencil highlight), draw planned UML elements and
  // planned edges on top. Live members keep their Floor positions.
  const liveOverlaySheetId = useSheetStore(s => s.activeSheetId)
  const overlaySheetId = isolatedScene ? null : liveOverlaySheetId
  // Sheet mode outlives its own exit so the departure can animate. See
  // sheetPhase.ts - a class that vanishes with the state can only fade IN.
  const sheetPhase = useSheetPhase(overlaySheetId)
  const liveVisibleSheetIds = useSheetStore(s => s.visibleSheetIds)
  const emptyReviewVisibleSheetIds = useMemo<string[]>(() => [], [])
  const visibleSheetIds = reviewMode ? emptyReviewVisibleSheetIds : liveVisibleSheetIds
  const layersById = useSheetStore(s => s.layersById)
  const overlayElements = useSheetStore(s => s.elements)
  const liveWorkspaceIdForOverlay = useGraphStore(s => s.currentProject?.id ?? '')
  const workspaceIdForOverlay = reviewScene?.workspaceId ?? liveWorkspaceIdForOverlay

  // Resolve bottom-to-top, always applying the primary sheet last. A node has
  // one visual owner, so secondary layers contribute nodes but never create a
  // second instance of the same live model element.
  const visibleLayers = useMemo(() => {
    const ordered = visibleSheetIds.filter(id => id !== overlaySheetId)
    if (overlaySheetId && visibleSheetIds.includes(overlaySheetId)) ordered.push(overlaySheetId)
    return ordered.map(id => layersById[id]).filter(Boolean)
  }, [visibleSheetIds, overlaySheetId, layersById])

  const effectiveElements = useMemo(() => {
    const byNodeId = new Map<string, (typeof overlayElements)[number]>()
    for (const layer of visibleLayers) {
      for (const e of layer.elements) {
        const nodeId = e.systemId ?? e.fileId ?? e.infraId
        if (nodeId) byNodeId.set(nodeId, e)
      }
    }
    return byNodeId
  }, [visibleLayers, overlayElements])
  const sheetOpinionIds = useMemo(() => new Set(visibleLayers.flatMap(layer => [
    ...layer.elements.flatMap(element => {
      const id = element.systemId ?? element.fileId ?? element.infraId
      return id ? [id] : []
    }),
    ...layer.planned.map(node => `planned:${node.id}`),
    ...layer.layouts.map(layout => layout.nodeId),
  ])), [visibleLayers])

  const activeElementByNodeId = useMemo(() => {
    const result = new Map<string, (typeof overlayElements)[number]>()
    for (const e of overlayElements) {
      const nodeId = e.systemId ?? e.fileId ?? e.infraId
      if (nodeId) result.set(nodeId, e)
    }
    return result
  }, [overlayElements])

  const overlayPlanned = useMemo(() => visibleLayers.flatMap(layer => layer.planned), [visibleLayers])
  const overlayPlannedEdges = useMemo(() => visibleLayers.flatMap(layer => layer.plannedEdges), [visibleLayers])
  const visiblePlannedByNodeId = useMemo(() => new Map(
    overlayPlanned.map(p => [`planned:${p.id}`, p]),
  ), [overlayPlanned])
  const activePlannedByNodeId = useMemo(() => new Map(
    (layersById[overlaySheetId ?? '']?.planned ?? []).map(p => [`planned:${p.id}`, p]),
  ), [layersById, overlaySheetId])
  const activeNodeIds = useMemo(() => sheetEditableNodeIds({
    activeSheetId: overlaySheetId,
    // Live entities are shared with the Floor. Moving one for the first time
    // promotes its geometry into a sparse sheet layout row.
    liveNodeIds: [
      ...systems.map(system => system.id),
      ...files.map(file => file.id),
      ...infraNodes.map(infra => infra.id),
    ],
    activePlannedNodeIds: activePlannedByNodeId.keys(),
    activeLayoutNodeIds: (layersById[overlaySheetId ?? '']?.layouts ?? []).map(layout => layout.nodeId),
  }), [overlaySheetId, systems, files, infraNodes, activePlannedByNodeId, layersById])
  // A sheet is a sparse set of layout opinions over the complete live Floor.
  // Overlaying those full rows gives the one canonical layout input used by
  // projection, drag/drop, resize, and tidy. Legacy columns are read only as an
  // upgrade fallback for a node whose canonical row has not arrived yet.
  const sheetEffectiveLayouts = useMemo<FloorLayout[]>(() => {
    const byId = new Map(floorLayouts.map(layout => [layout.nodeId, layout]))
    const liveSystems = new Map(systems.map(system => [system.id, system]))
    const liveFiles = new Map(files.map(file => [file.id, file]))
    const liveInfra = new Map(infraNodes.map(infra => [infra.id, infra]))
    const plannedInfraIds = new Set(overlayPlanned
      .filter(node => node.kind === 'infra')
      .map(node => `planned:${node.id}`))
    const parentType = (id: string | null): 'system' | 'infra' | null => id
      ? (liveInfra.has(id) || plannedInfraIds.has(id) ? 'infra' : 'system')
      : null
    const containment = (type: 'system' | 'infra' | null) => type === 'infra'
      ? 'hosted_by' as const
      : type === 'system' ? 'part_of' as const : 'root' as const
    for (const layer of visibleLayers) {
      const canonicalIds = new Set(layer.layouts.map(layout => layout.nodeId))
      for (const element of layer.elements) {
        const nodeId = element.systemId ?? element.fileId ?? element.infraId
        if (!nodeId || canonicalIds.has(nodeId)) continue
        const previous = byId.get(nodeId)
        const nodeType: FloorNodeType = element.systemId ? 'system' : element.fileId ? 'file' : 'infra'
        const infra = liveInfra.get(nodeId)
        const type = parentType(element.parentSystemId)
        byId.set(nodeId, {
          workspaceId: workspaceIdForOverlay,
          nodeId,
          nodeType,
          parentNodeId: element.parentSystemId,
          parentNodeType: type,
          containmentKind: containment(type),
          positionX: element.positionX,
          positionY: element.positionY,
          width: element.width ?? previous?.width
            ?? liveSystems.get(nodeId)?.width ?? liveFiles.get(nodeId)?.width
            ?? (infra?.category === 'platform' ? 760 : infra ? 260 : BASE_FILE_W),
          height: element.height ?? previous?.height
            ?? liveSystems.get(nodeId)?.height ?? liveFiles.get(nodeId)?.height
            ?? (infra?.category === 'platform' ? 520 : infra ? 160 : BASE_FILE_H),
          scale: element.scale ?? previous?.scale ?? 1,
          interiorScale: previous?.interiorScale ?? 1,
          updatedAt: 0,
        })
      }
      for (const planned of layer.planned) {
        const nodeId = `planned:${planned.id}`
        if (canonicalIds.has(nodeId)) continue
        const metadata = plannedMetadata(planned)
        const nodeType: FloorNodeType = planned.kind === 'system'
          ? 'system' : planned.kind === 'infra' ? 'infra' : 'file'
        const type = parentType(planned.parentSystemId)
        byId.set(nodeId, {
          workspaceId: workspaceIdForOverlay,
          nodeId,
          nodeType,
          parentNodeId: planned.parentSystemId,
          parentNodeType: type,
          containmentKind: containment(type),
          positionX: planned.positionX,
          positionY: planned.positionY,
          width: planned.width ?? (nodeType === 'system'
            ? 620 : nodeType === 'infra' ? (metadata.category === 'platform' ? 760 : 260) : BASE_FILE_W),
          height: planned.height ?? (nodeType === 'system'
            ? 420 : nodeType === 'infra' ? (metadata.category === 'platform' ? 520 : 160) : BASE_FILE_H),
          scale: planned.scale ?? 1,
          interiorScale: 1,
          updatedAt: 0,
        })
      }
      for (const layout of layer.layouts) byId.set(layout.nodeId, layout)
    }
    return [...byId.values()]
  }, [floorLayouts, systems, files, infraNodes, overlayPlanned, visibleLayers, workspaceIdForOverlay])
  const sheetSystemIds = useMemo(() => new Set([
    ...systems.map(system => system.id),
    ...overlayPlanned.filter(node => node.kind === 'system').map(node => `planned:${node.id}`),
  ]), [systems, overlayPlanned])
  const sheetFileIds = useMemo(() => new Set([
    ...files.map(file => file.id),
    ...overlayPlanned.filter(node => node.kind !== 'system' && node.kind !== 'infra').map(node => `planned:${node.id}`),
  ]), [files, overlayPlanned])
  const sheetInfraIds = useMemo(() => new Set([
    ...infraNodes.map(infra => infra.id),
    ...overlayPlanned.filter(node => node.kind === 'infra').map(node => `planned:${node.id}`),
  ]), [infraNodes, overlayPlanned])
  const [isTransitioningLayout, setIsTransitioningLayout] = useState(false)
  // Placements decided for nodes with no persisted row. Refs, not state: they
  // must survive every reprojection without causing one. See GeneratedPlacement.
  const floorPlacementsRef = useRef(new Map<string, GeneratedPlacement>())
  const sheetPlacementsRef = useRef(new Map<string, GeneratedPlacement>())
  // True for the whole of any drag gesture, including a box-selection drag.
  // Reconciliation easing must be off for the entire scene while dragging or
  // node bodies glide behind the cursor while their chrome tracks it exactly.
  const [isDraggingScene, setIsDraggingScene] = useState(false)

  useLayoutEffect(() => {
    setIsTransitioningLayout(true)
    const timer = window.setTimeout(() => setIsTransitioningLayout(false), 500)
    return () => window.clearTimeout(timer)
  }, [overlaySheetId, visibleSheetIds.join('|')])

  useEffect(() => {
    setInspectedNode(null)
    setInfraPickerNode(null)
  }, [overlaySheetId, setInspectedNode, setInfraPickerNode])

  const composedNodes = useMemo(() => {
    const transition = isTransitioningLayout
      ? 'transform 500ms cubic-bezier(0.16, 1, 0.3, 1), width 500ms cubic-bezier(0.16, 1, 0.3, 1), height 500ms cubic-bezier(0.16, 1, 0.3, 1), opacity 400ms ease-in-out'
      : undefined
    if (visibleLayers.length === 0) {
      return isTransitioningLayout
        ? rfNodes.map(n => ({ ...n, style: { ...n.style, transition } }))
        : rfNodes
    }

    const visiblePlanned = overlayPlanned.filter(p => p.status !== 'flattened')
    const plannedSystems: DbSystem[] = visiblePlanned
      .filter(p => p.kind === 'system')
      .map(p => ({
        id: `planned:${p.id}`,
        workspaceId: p.workspaceId,
        name: p.name,
        parentId: p.parentSystemId,
        source: p.createdBy === 'agent' ? 'agent' : 'user',
        color: p.color || null,
        description: plannedMetadata(p).description || p.notes || null,
        agentNotes: null,
        depth: 0,
        positionX: p.positionX,
        positionY: p.positionY,
        width: p.width,
        height: p.height,
        createdAt: 0,
        updatedAt: 0,
      }))
    const virtualSystems: DbSystem[] = systems.map(system => ({ ...system })).concat(plannedSystems)
    const plannedFiles: DbFile[] = visiblePlanned
      .filter(p => p.kind !== 'system' && p.kind !== 'infra')
      .map(p => {
        const metadata = plannedMetadata(p)
        const inferredLanguage = languageFromFilename(p.name)?.id ?? ''
        return {
          id: `planned:${p.id}`,
          rootId: '',
          path: p.declaredPath || p.name,
          relPath: p.declaredPath || p.name,
          language: metadata.language ?? inferredLanguage,
          systemId: p.parentSystemId,
          lineCount: 0,
          churnScore: 0,
          shape: p.shape === 'cylinder' || p.shape === 'hexagon'
            ? p.shape
            : (p.kind === 'class' ? 'class' : ''),
          displayName: p.kind === 'class' ? p.name : '',
          positionX: p.positionX,
          positionY: p.positionY,
          width: p.width,
          height: p.height,
          indexedAt: 0,
        }
      })
    const virtualFiles: DbFile[] = files.map(file => ({ ...file })).concat(plannedFiles)
    const plannedInfra: DbInfraNode[] = visiblePlanned
      .filter(p => p.kind === 'infra')
      .map(p => {
        const metadata = plannedMetadata(p)
        return {
          id: `planned:${p.id}`,
          workspaceId: p.workspaceId,
          name: p.name,
          infraType: metadata.category ?? 'api',
          category: (metadata.category ?? 'api') as DbInfraNode['category'],
          provider: metadata.provider ?? 'generic',
          service: metadata.service ?? '',
          subtype: metadata.subtype ?? '',
          status: 'proposed',
          config: {},
          positionX: p.positionX,
          positionY: p.positionY,
        }
      })
    const virtualInfra = infraNodes.map(infra => ({ ...infra })).concat(plannedInfra)
    const sheetLayout = applyZoomVisibility(buildFloorFrameLayout(
      virtualSystems, virtualFiles, virtualInfra, dependencies, sheetEffectiveLayouts,
      currentZoomRef.current, sheetPlacementsRef.current,
    ).rfNodes, currentZoomRef.current)
    const floorById = new Map(rfNodes.map(n => [n.id, n]))
    const morphed = sheetLayout.map(sheetNode => {
      const floorNode = floorById.get(sheetNode.id)
      const planned = visiblePlannedByNodeId.get(sheetNode.id)
      const editablePlanned = activePlannedByNodeId.get(sheetNode.id)
      const sheetElement = effectiveElements.get(sheetNode.id)
      const editableElement = activeElementByNodeId.get(sheetNode.id)
      const metadata = planned ? plannedMetadata(planned) : undefined
      const liveDesignMetadata = sheetElement ? sheetElementMetadata(sheetElement) : undefined
      const suppliedSymbols = planned && planned.kind !== 'system' && planned.kind !== 'infra'
        ? (() => {
            const rows: Array<{ name: string; kind: string; lineStart: number; lineEnd: number }> = []
            if (planned.kind === 'class') {
              metadata?.attributes?.forEach(item => rows.push({ name: `${item.name}${item.dataType ? `: ${item.dataType}` : ''}`, kind: 'variable', lineStart: 0, lineEnd: 0 }))
              metadata?.methods?.forEach(item => rows.push({ name: item.name, kind: 'method', lineStart: 0, lineEnd: 0 }))
            } else if (planned.kind === 'service') {
              metadata?.endpoints?.forEach(item => rows.push({ name: item.name, kind: 'method', lineStart: 0, lineEnd: 0 }))
            } else {
              ;(metadata?.symbols ?? metadata?.exports?.map(name => ({ name, kind: 'variable' })) ?? []).forEach(item =>
                rows.push({ name: item.name, kind: item.kind, lineStart: 0, lineEnd: 0 }))
            }
            if (rows.length === 0) plannedMembers(planned).forEach(member => rows.push({
              name: member.signature.split('(')[0]?.trim() || member.signature, kind: 'method', lineStart: 0, lineEnd: 0,
            }))
            return rows
          })()
        : sheetNode.type === 'file' && liveDesignMetadata?.symbols
          ? liveDesignMetadata.symbols.map(symbol => ({ ...symbol, lineStart: 0, lineEnd: 0 }))
          : undefined
      const nodeOpacity = typeof sheetNode.style?.opacity === 'number' ? sheetNode.style.opacity : 1
      const isFloorContextNode = !effectiveElements.has(sheetNode.id) && !planned
      const isSheetPlaced = sheetOpinionIds.has(sheetNode.id)
      const isStructuralFloorContext = Boolean(
        floorNode && sheetNode.type === 'system' && !effectiveElements.has(sheetNode.id),
      )
      const sheetW = parseFloat(String(sheetNode.style?.width ?? 0))
      const sheetH = parseFloat(String(sheetNode.style?.height ?? 0))
      const renderedW = sheetW
      const renderedH = sheetH
      return {
        ...sheetNode,
        selected: selectedIdsRef.current.has(sheetNode.id),
        data: {
          // Runtime/focus/trace flags belong to the live entity and survive a
          // proposal projection. Canonical sheet geometry data wins afterward.
          ...floorNode?.data,
          ...sheetNode.data,
          sheetPlaced: isSheetPlaced,
          ...(planned && planned.kind !== 'system' ? {
            label: planned.name,
            displayName: planned.name,
            relPath: planned.declaredPath || planned.name,
          } : {}),
          ...(planned ? {
            umlKind: planned.kind,
            umlMetadata: plannedMetadata(planned),
          } : {}),
          ...(suppliedSymbols ? { symbols: suppliedSymbols } : {}),
          ...(editablePlanned ? {
            onChooseInfra: editablePlanned.kind === 'infra' ? () => setInfraPickerNode(editablePlanned.id) : undefined,
            onRename: (name: string) => {
              const current = useSheetStore.getState().planned.find(p => p.id === editablePlanned.id)
              if (!current) return
              const inferred = current.kind === 'file' ? languageFromFilename(name) : undefined
              const nextMetadata = inferred ? { ...plannedMetadata(current), language: inferred.id } : current.metadata
              void useSheetStore.getState().updatePlanned(workspaceIdForOverlay, {
                ...current, name, declaredPath: current.kind === 'file' ? name : '', metadata: nextMetadata,
              })
            },
            onLanguageChange: editablePlanned.kind === 'class' || editablePlanned.kind === 'file' ? (language: string) => {
              const current = useSheetStore.getState().planned.find(p => p.id === editablePlanned.id)
              if (!current) return
              const name = current.kind === 'file' ? filenameForLanguage(current.name, language) : current.name
              void useSheetStore.getState().updatePlanned(workspaceIdForOverlay, {
                ...current, name, declaredPath: current.kind === 'file' ? name : '',
                metadata: { ...plannedMetadata(current), language },
              })
            } : undefined,
            onSymbolsChange: (symbols: Array<{ name: string; kind: string }>) => {
              const current = useSheetStore.getState().planned.find(p => p.id === editablePlanned.id)
              if (!current) return
              const meta = plannedMetadata(current)
              let next: PlannedNodeMetadata
              if (current.kind === 'class') {
                const methods = symbols.filter(symbol => symbol.kind === 'function' || symbol.kind === 'method').map((symbol, index) => ({
                  ...(meta.methods?.[index] ?? { visibility: 'public' as const, parameters: [], returnType: '' }), name: symbol.name,
                }))
                const attributes = symbols.filter(symbol => symbol.kind !== 'function' && symbol.kind !== 'method' && symbol.kind !== 'class').map((symbol, index) => {
                  const [name, dataType = ''] = symbol.name.split(':').map(part => part.trim())
                  return { ...(meta.attributes?.[index] ?? { visibility: 'private' as const }), name, dataType }
                })
                next = { ...meta, methods, attributes }
              } else if (current.kind === 'service') {
                next = { ...meta, endpoints: symbols.map((symbol, index) => ({
                  ...(meta.endpoints?.[index] ?? { visibility: 'public' as const, parameters: [], returnType: '' }), name: symbol.name,
                })) }
              } else next = { ...meta, symbols: symbols.map(({ name, kind }) => ({ name, kind })) }
              void useSheetStore.getState().updatePlanned(workspaceIdForOverlay, { ...current, metadata: next })
            },
            onUmlMetadataChange: (metadata: PlannedNodeMetadata) => {
              const current = useSheetStore.getState().planned.find(p => p.id === editablePlanned.id)
              if (current) void useSheetStore.getState().updatePlanned(
                workspaceIdForOverlay, {
                  ...current, metadata,
                  ...((current.kind === 'class' || current.kind === 'file') && metadata.path !== undefined
                    ? { declaredPath: metadata.path }
                    : {}),
                },
              )
            },
          } : {}),
          ...(!editablePlanned && editableElement && sheetNode.type === 'file' ? {
            onSymbolsChange: (symbols: Array<{ name: string; kind: string }>) => {
              const current = useSheetStore.getState().elements.find(element => element.id === editableElement.id)
              if (!current) return
              const currentMetadata = sheetElementMetadata(current) ?? { version: 1 as const }
              void useSheetStore.getState().updateElementMetadata(workspaceIdForOverlay, current.id, {
                ...currentMetadata,
                symbols: symbols.map(({ name, kind }) => ({ name, kind })),
              }).catch(error => console.error('[sheets] live file design metadata update failed:', error))
            },
          } : {}),
          ...(isStructuralFloorContext ? { nodeW: renderedW, nodeH: renderedH } : {}),
        },
        style: {
          ...sheetNode.style,
          ...(isStructuralFloorContext ? { width: renderedW, height: renderedH } : {}),
          // Structural context is NOT scenery. It renders at full fidelity and
          // stays clickable, because a sheet is where you work on the
          // architecture - dimming the thing you are reasoning about is what
          // made a sheet feel like drawing on glass over the map.
          ...(isFloorContextNode ? { pointerEvents: 'auto' as const } : {}),
          transition,
        },
        domAttributes: {
          ...sheetNode.domAttributes,
          'data-sheet-placed': isSheetPlaced ? 'true' : undefined,
        },
        draggable: activeNodeIds.has(sheetNode.id) && nodeOpacity > 0.1,
        // Context nodes are selectable so they can be inspected, connected and
        // included in a prompt. Only repositioning is reserved for the sheet's
        // own members, since a sheet-local move has to persist as an override.
        selectable: nodeOpacity > 0.1,
        zIndex: sheetNode.id.startsWith('planned:') ? 10000 : sheetNode.zIndex,
      }
    })
    return morphed
  }, [rfNodes, visibleLayers, effectiveElements, sheetOpinionIds, activeElementByNodeId, systems, files, infraNodes, dependencies, overlayPlanned, isTransitioningLayout, visiblePlannedByNodeId, activePlannedByNodeId, activeNodeIds, selectedNodeId, selectionRevision, workspaceIdForOverlay, setInfraPickerNode, sheetEffectiveLayouts])

  const [sheetInteractionNodes, setSheetInteractionNodes] = useState<Node[] | null>(null)
  useEffect(() => setSheetInteractionNodes(null), [overlaySheetId, visibleSheetIds.join('|')])
  const displayNodes = sheetInteractionNodes ?? composedNodes
  const displayNodesRef = useRef<Node[]>(displayNodes)
  displayNodesRef.current = displayNodes
  const navigableDisplayNodes = useMemo(
    () => revealNodePath(displayNodes, selectedNodeId),
    [displayNodes, selectedNodeId],
  )

  /**
   * Record a new selection and repaint the scene from it in one step.
   *
   * Selection reaches the screen by several routes - the layout projection, the
   * sheet projection, React Flow's own select changes - and any gesture that
   * updated only some of them left the highlight disagreeing with what the next
   * drag would actually pick up. Every deliberate selection change goes through
   * here so the set and the pixels can never drift apart. The sheet snapshot is
   * only touched when it already exists; creating one here would freeze the
   * scene outside a gesture.
   */
  const applySelection = useCallback((next: Set<string>) => {
    commitSelection(next)
    setRfNodes(current => stampSelection(current, next))
    setSheetInteractionNodes(current => current && stampSelection(current, next))
  }, [commitSelection])
  const livingRevealIds = useMemo(() => {
    // A node appears only for its own stage: first the edited origin, then the
    // impact target. The top-layer flow can route to hidden authored geometry
    // without prematurely revealing both endpoints.
    return new Set(Object.keys(nodeFx))
  }, [nodeFx])
  // Live FX are a projection, not mutable canvas state. Deriving them here
  // means layout, selection, zoom, and sheet updates cannot accidentally
  // overwrite an in-flight edit signal in rfNodes.
  const livingDisplayNodes = useMemo(
    () => surfaceLivingNodeFx(
      stampAgentPresence(navigableDisplayNodes, activeWorkSessions),
      nodeFx,
      livingVisibilityOptions,
      livingRevealIds,
    ),
    [navigableDisplayNodes, activeWorkSessions, nodeFx, livingVisibilityOptions, livingRevealIds],
  )

  // ── Morning Delta review ────────────────────────────────────────────────
  // Marks are a projection over the living nodes, layered the same way live FX
  // are: reviewing never mutates canvas state, so ending a review restores the
  // map exactly and an incoming live edit still animates on top of a mark.
  const deltaKnownNodeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const file of files) ids.add(file.id)
    for (const system of systems) ids.add(system.id)
    return ids
  }, [files, systems])
  const deltaReview = useMemo(
    () => buildDeltaReview(deltaReviewing ? delta : null, deltaKnownNodeIds),
    [delta, deltaReviewing, deltaKnownNodeIds],
  )
  const deltaFocusTargets = useMemo(() => {
    const claims = [...deltaReview.claims, ...deltaReview.internalClaims]
    const index = clampClaimCursor(claims, deltaCursor)
    return claimFocusTargets(index >= 0 ? claims[index] : null, deltaKnownNodeIds)
  }, [deltaReview, deltaCursor, deltaKnownNodeIds])
  const reviewDisplayNodes = useMemo(
    () => applyDeltaMarks(livingDisplayNodes, deltaReview, deltaFocusTargets),
    [livingDisplayNodes, deltaReview, deltaFocusTargets],
  )
  // Agent attention: "my agent is reading here, right now". A projection like
  // every other live signal, and the only visual the action stream owns -
  // writes and traces are animated by the semantic stream that already
  // broadcasts them, never twice. See agentActionVisual.ts.
  const surfacedAttention = useMemo(
    () => surfaceAgentAttention(reviewDisplayNodes, agentAttention, livingVisibilityOptions),
    [reviewDisplayNodes, agentAttention, livingVisibilityOptions],
  )
  const attentionNodes = useMemo(
    () => applyAgentAttention(reviewDisplayNodes, surfacedAttention),
    [reviewDisplayNodes, surfacedAttention],
  )
  // Selecting a claim is explicit navigation, so it frames immediately rather
  // than deferring to the idle-aware growth fit.
  //
  // The bounds matter more than the fit. DELTA_REVIEW_MIN_ZOOM stops a claim
  // about two small nodes from dropping the camera at an unreadable scale, and
  // the max keeps a two-system boundary from filling the screen with one box.
  // A claim with nothing on canvas (a tombstone) leaves the camera alone
  // instead of jumping somewhere arbitrary.
  const deltaFocusKey = deltaFocusTargets.join('|')
  useEffect(() => {
    if (!deltaReviewing || !deltaFocusKey) return
    void fitView({
      nodes: deltaFocusKey.split('|').map(id => ({ id })),
      padding: DELTA_REVIEW_PADDING,
      duration: 620,
      minZoom: DELTA_REVIEW_MIN_ZOOM,
      maxZoom: DELTA_REVIEW_MAX_ZOOM,
    })
  }, [deltaReviewing, deltaFocusKey, fitView])
  const updateInteractiveNodes = useCallback((updater: (nodes: Node[]) => Node[]) => {
    if (useSheetStore.getState().activeSheetId) {
      setSheetInteractionNodes(current => updater(current ?? displayNodesRef.current))
    } else {
      setRfNodes(updater)
    }
  }, [])

  const displayEdges = useMemo(() => {
    const visibility = livingVisibilityIndex(displayNodes, livingVisibilityOptions)
    const surfacedRfEdges = rfEdges.flatMap(edge => {
      if (edge.className !== 'trace-edge') return [edge]
      const source = visibility.visibleNodeId(edge.source)
      const target = visibility.visibleNodeId(edge.target)
      return source && target && source !== target ? [{ ...edge, source, target }] : []
    })
    if (visibleLayers.length === 0) return surfacedRfEdges
    const visibleIds = new Set(displayNodes.filter(n => n.style?.opacity !== 0).map(n => n.id))
    const plannedRf: Edge[] = overlayPlannedEdges.map(e => ({
      id: `pedge:${e.id}`,
      source: e.srcPlanned ? `planned:${e.srcPlanned}` : (e.srcLive ?? ''),
      target: e.dstPlanned ? `planned:${e.dstPlanned}` : (e.dstLive ?? ''),
      label: e.kind,
      animated: true,
      style: { strokeDasharray: '6 4', stroke: 'var(--accent)' },
      labelStyle: { fontSize: 8, fontFamily: 'var(--font-mono)', fill: 'var(--text-secondary)' },
      zIndex: 10000,
    })).filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    return [
      ...surfacedRfEdges.map(e => visibleIds.has(e.source) && visibleIds.has(e.target)
        ? e
        : { ...e, style: { ...e.style, opacity: 0 }, selectable: false }),
      ...plannedRf,
    ]
  }, [rfEdges, visibleLayers, overlayPlannedEdges, displayNodes, livingVisibilityOptions])

  /**
   * Was this gesture released over the unclassified bin?
   *
   * The bin is pinned to the viewport, not placed in world space, so this is a
   * screen-space hit test against the rendered element rather than anything the
   * layout engine knows about. Reading the live rect means the test cannot
   * drift out of sync with where the bin actually is.
   */
  /**
   * Is this screen point over somewhere a Floor node can be dropped to unsort it?
   *
   * The closed bin and the open bin window are both valid targets: once the
   * window is open it is the obvious place to drop, and refusing it because the
   * small tile is now behind it would be a trap.
   */
  const pointOverBinTarget = useCallback((point: { x: number; y: number } | null): boolean => {
    if (readOnly || isolatedScene || !point) return false
    const targets = document.querySelectorAll('[data-bin="unclassified"], [data-bin-window]')
    for (const target of targets) {
      const rect = target.getBoundingClientRect()
      if (point.x >= rect.left && point.x <= rect.right
        && point.y >= rect.top && point.y <= rect.bottom) return true
    }
    return false
  }, [readOnly, isolatedScene])

  const droppedOnUnclassifiedBin = useCallback(
    (event: React.MouseEvent | MouseEvent | TouchEvent): boolean =>
      pointOverBinTarget(pointerOf(event)),
    [pointOverBinTarget],
  )

  const systemAtScreenPoint = useCallback((
    clientX: number,
    clientY: number,
    explain = false,
  ): string | null => {
    const point = screenToFlowPosition({ x: clientX, y: clientY })
    const systemIds = new Set(systems.map(system => system.id))
    let target: { id: string; depth: number } | null = null
    const examined: Array<Record<string, unknown>> = []
    for (const node of rfNodesRef.current) {
      if (!systemIds.has(node.id)) continue
      const internal = getInternalNode(node.id)
      const origin = internal?.internals.positionAbsolute ?? node.position
      const width = Number(node.style?.width ?? node.measured?.width ?? 0)
      const height = Number(node.style?.height ?? node.measured?.height ?? 0)
      const hit = point.x >= origin.x && point.x <= origin.x + width
        && point.y >= origin.y && point.y <= origin.y + height
      if (explain && binDragDebug() && examined.length < 6) {
        examined.push({ id: node.id, x: origin.x, y: origin.y, width, height, hit })
      }
      if (!hit) continue
      const depth = Number((node.data as Record<string, unknown> | undefined)?.depth ?? 0)
      if (!target || depth >= target.depth) target = { id: node.id, depth }
    }
    if (explain && binDragDebug()) {
      console.log('[bins] systemAtScreenPoint', {
        client: { x: clientX, y: clientY },
        flow: point,
        systemsInScene: systemIds.size,
        nodesInScene: rfNodesRef.current.length,
        systemNodesFound: rfNodesRef.current.filter(n => systemIds.has(n.id)).length,
        firstFew: examined,
        result: target?.id ?? null,
      })
    }
    return target?.id ?? null
  }, [screenToFlowPosition, systems, getInternalNode])

  /**
   * Move a file into a system, or out of every system when null.
   *
   * Optimistic, because the file must leave the bin on the same frame the
   * pointer released it. A failed write puts it back rather than leaving the
   * canvas asserting a placement the daemon rejected.
   */
  const placeFile = useCallback((fileId: string, systemId: string | null) => {
    holdCameraForGesture()
    const state = useGraphStore.getState()
    const workspaceId = state.currentProject?.id
    const known = state.files.find(file => file.id === fileId)
    const previous = known?.systemId ?? null
    if (binDragDebug()) {
      console.log('[bins] placeFile', {
        fileId, systemId, workspaceId, previous,
        fileIsKnownToTheStore: !!known,
        willWrite: !!workspaceId && previous !== systemId,
      })
    }
    if (!workspaceId || previous === systemId) return
    useGraphStore.setState(current => ({
      files: current.files.map(file => file.id === fileId ? { ...file, systemId } : file),
    }))
    void apiAssignFile(fileId, systemId, workspaceId).catch(error => {
      console.error('[bins] could not move file', error)
      useGraphStore.setState(current => ({
        files: current.files.map(file => file.id === fileId ? { ...file, systemId: previous } : file),
      }))
    })
  }, [holdCameraForGesture])

  /**
   * Put a file on the Floor at a screen point without giving it a system.
   *
   * The row itself is the statement: geometry at the Floor root exists only
   * because someone put it there, which is what distinguishes a file placed on
   * the map from one still waiting in the bin.
   */
  const placeFileLoose = useCallback((fileId: string, clientX: number, clientY: number) => {
    holdCameraForGesture()
    const workspaceId = useGraphStore.getState().currentProject?.id
    if (!workspaceId) return
    const point = screenToFlowPosition({ x: clientX, y: clientY })
    const layout = {
      nodeId: fileId,
      nodeType: 'file' as const,
      parentNodeId: null,
      parentNodeType: null,
      containmentKind: 'root' as const,
      // Dropped by the cursor, so the cursor marks the middle of the card.
      positionX: point.x - BASE_FILE_W / 2,
      positionY: point.y - BASE_FILE_H / 2,
      width: BASE_FILE_W,
      height: BASE_FILE_H,
      scale: 1,
      interiorScale: 1,
    }
    useGraphStore.setState(state => ({
      floorLayouts: [
        ...state.floorLayouts.filter(item => !(item.nodeType === 'file' && item.nodeId === fileId)),
        { ...layout, workspaceId, updatedAt: Date.now() },
      ],
    }))
    void apiSaveFloorLayouts(workspaceId, [layout]).catch(error => {
      console.error('[bins] could not place file on the Floor', error)
      useGraphStore.setState(state => ({
        floorLayouts: state.floorLayouts.filter(
          item => !(item.nodeType === 'file' && item.nodeId === fileId),
        ),
      }))
    })
  }, [screenToFlowPosition, holdCameraForGesture])

  // The Floor answers "which system is under this point?" for the bin canvas,
  // which cannot know that itself. Registered only by the real Floor: an
  // isolated scene has no authority over the workspace.
  useEffect(() => {
    if (isolatedScene || readOnly) return
    return registerFloorDropTarget({
      systemAt: systemAtScreenPoint,
      place: placeFile,
      placeLoose: placeFileLoose,
      element: () => canvasRootRef.current,
    })
  }, [isolatedScene, readOnly, systemAtScreenPoint, placeFile, placeFileLoose])

  /**
   * Resolve a bin drag, wherever the pointer let go.
   *
   * Idempotent: React Flow's own `onNodeDragStop` still fires when the gesture
   * ends inside the bin, so both paths call this and the first one wins.
   */
  /** Whether the pointer is currently over a bin, so enter/leave fire once. */
  const binCrossingRef = useRef(false)
  const binDragNodeRef = useRef<string | null>(null)
  const finishBinDrag = useCallback((clientX: number, clientY: number, source: string) => {
    const nodeId = binDragNodeRef.current
    if (!nodeId) return
    binDragNodeRef.current = null
    hideBinGhost()
    const placed = dropOnFloorAt(nodeId, clientX, clientY)
    if (binDragDebug()) {
      console.debug('[bins] drag ended', {
        source, nodeId, clientX, clientY, placed,
        systemUnderPointer: systemAtFloorPoint(clientX, clientY),
      })
    }
    if (placed) return
    // Refused, or released back inside the bin. The node keeps whatever
    // position the gesture left it at, which for a drag that went outside the
    // window is somewhere the window clips - so it would simply be gone. Put it
    // back; the bin owns no geometry worth keeping.
    const origin = dragPositionRef.current.get(nodeId)
    if (origin) {
      setRfNodes(current => current.map(item =>
        item.id === nodeId ? { ...item, position: { ...origin } } : item))
    }
  }, [holdCameraForGesture])

  const beginBinDrag = useCallback((nodeId: string) => {
    binDragNodeRef.current = nodeId
    const onPointerUp = (event: PointerEvent) => {
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      finishBinDrag(event.clientX, event.clientY, 'window-pointerup')
    }
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
    if (binDragDebug()) console.debug('[bins] drag started', { nodeId })
  }, [finishBinDrag])

  /**
   * Send a file back to the bin: out of its system, and out of any placement it
   * had on the bare Floor.
   *
   * Both have to go. Clearing the system alone would leave a loose file still
   * holding root geometry, which is exactly what marks it as placed - so it
   * would sit on the Floor claiming to be sorted while the bin said otherwise.
   */
  const unclassifyDraggedFile = useCallback((nodeId: string) => {
    holdCameraForGesture()
    const state = useGraphStore.getState()
    const workspaceId = state.currentProject?.id
    const file = state.files.find(item => item.id === nodeId)
    // Systems and infra have no "unclassified" state to fall into, so the bin
    // simply refuses them rather than pretending the drop did something.
    if (!workspaceId || !file) return
    const previousSystem = file.systemId ?? null
    const previousLayouts = state.floorLayouts
    if (!previousSystem && !previousLayouts.some(
      item => item.nodeType === 'file' && item.nodeId === nodeId,
    )) return

    useGraphStore.setState(current => ({
      files: current.files.map(item => item.id === nodeId ? { ...item, systemId: null } : item),
      floorLayouts: current.floorLayouts.filter(
        item => !(item.nodeType === 'file' && item.nodeId === nodeId),
      ),
    }))
    const restore = (error: unknown) => {
      console.error('[bins] could not return file to the bin', error)
      useGraphStore.setState(current => ({
        files: current.files.map(item =>
          item.id === nodeId ? { ...item, systemId: previousSystem } : item),
        floorLayouts: previousLayouts,
      }))
    }
    void Promise.all([
      previousSystem ? apiAssignFile(nodeId, null, workspaceId) : Promise.resolve(),
      apiRemoveFloorLayouts(workspaceId, [{ nodeId, nodeType: 'file' }]),
    ]).catch(restore)
  }, [])

  /**
   * Resolve a Floor drag that ended over a bin, wherever the pointer let go.
   *
   * The mirror of the bin's problem, and the same cure. The bin window is
   * portalled to the document, so releasing over it means releasing over a
   * different React Flow instance's pane - whose own pointer handling swallows
   * the event the Floor's drag terminates on. The node stayed on the cursor
   * until it wandered back over the Floor, exactly as it did in reverse.
   *
   * So the Floor owns this terminating event too. Idempotent with React Flow's
   * own dragStop, whichever arrives first.
   */
  const floorBinDragRef = useRef<string | null>(null)
  const finishFloorBinDrag = useCallback((clientX: number, clientY: number, source: string) => {
    binCrossingRef.current = false
    reactFlowStore.setState({ autoPanOnNodeDrag: true })
    const nodeId = floorBinDragRef.current
    if (!nodeId) return false
    floorBinDragRef.current = null
    hideBinGhost()
    const overBin = pointOverBinTarget({ x: clientX, y: clientY })
    if (binDragDebug()) {
      console.log('[bins] floor drag ended', { source, nodeId, clientX, clientY, overBin })
    }
    if (!overBin) return false
    unclassifyDraggedFile(nodeId)
    return true
  }, [pointOverBinTarget, unclassifyDraggedFile, reactFlowStore])

  const beginFloorBinDrag = useCallback((nodeId: string) => {
    floorBinDragRef.current = nodeId
    const onPointerUp = (event: PointerEvent) => {
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      finishFloorBinDrag(event.clientX, event.clientY, 'window-pointerup')
    }
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
  }, [finishFloorBinDrag])

  /**
   * Innermost system under a screen point, or null for bare canvas. Deepest
   * frame wins, matching how a node drop resolves its parent rather than
   * whichever container the hit test happens to reach first.
   */

  // Stencil drop: palette → canvas → planned element born in name-edit mode.
  const onOverlayDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/axiom-stencil')) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
    } else if (e.dataTransfer.types.includes(BINNED_FILE_MIME)) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
    }
  }, [])

  /**
   * A file dragged out of the unclassified bin onto a system joins it.
   *
   * The system is read from what is under the cursor rather than from a
   * selection, because the gesture already said where it goes. Dropping on bare
   * canvas is deliberately a no-op: the Floor root is not a system, so there is
   * nothing there for the file to join and silently leaving it unsorted is
   * more honest than inventing a home for it.
   */
  const onBinnedFileDrop = useCallback((e: React.DragEvent): boolean => {
    const raw = e.dataTransfer.getData(BINNED_FILE_MIME)
    if (!raw || readOnly || reviewMode) return false
    e.preventDefault()
    e.stopPropagation()
    let fileId: string
    try {
      fileId = (JSON.parse(raw) as { fileId: string }).fileId
    } catch (error) {
      console.error('[bins] ignored invalid binned-file payload', error)
      return true
    }
    const systemId = systemAtScreenPoint(e.clientX, e.clientY)
    if (systemId) placeFile(fileId, systemId)
    return true
  }, [readOnly, reviewMode, systemAtScreenPoint, placeFile])
  const onOverlayDrop = useCallback((e: React.DragEvent) => {
    if (readOnly) return
    if (onBinnedFileDrop(e)) return
    const raw = e.dataTransfer.getData('application/axiom-stencil')
    if (!raw || !overlaySheetId) return
    e.preventDefault()
    e.stopPropagation()
    let stencil: StencilDef
    try {
      stencil = JSON.parse(raw) as StencilDef
    } catch (error) {
      console.error('[sheets] ignored invalid stencil payload', error)
      return
    }
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const store = useSheetStore.getState()
    if (stencil.shape === 'note') {
      void store.createFloatingNote(workspaceIdForOverlay, overlaySheetId, 'New note - double-click to edit', pos.x, pos.y)
      return
    }
    void store.createPlanned(workspaceIdForOverlay, overlaySheetId, {
      name: `New${stencil.label.replace(/\s/g, '')}`,
      kind: stencil.kind,
      shape: stencil.shape as 'box' | 'folder' | 'cylinder' | 'hexagon',
      positionX: pos.x, positionY: pos.y,
    }).then(created => {
      if (created && stencil.kind === 'infra') {
        setSelectedNode(`planned:${created.id}`)
        setInfraPickerNode(created.id)
      }
    }).catch(err => console.error('[sheets] stencil creation failed:', err))
  }, [readOnly, overlaySheetId, workspaceIdForOverlay, screenToFlowPosition, setSelectedNode, setInfraPickerNode])

  const onConnectPlanned = useCallback((conn: Connection) => {
    if (!overlaySheetId || !conn.source || !conn.target) return
    const src = conn.source.startsWith('planned:') ? { srcPlanned: conn.source.slice(8) } : { srcLive: conn.source }
    const dst = conn.target.startsWith('planned:') ? { dstPlanned: conn.target.slice(8) } : { dstLive: conn.target }
    if (!conn.source.startsWith('planned:') && !conn.target.startsWith('planned:')) return
    void useSheetStore.getState().createPlannedEdge(workspaceIdForOverlay, overlaySheetId, {
      kind: 'DEPENDS_ON', ...src, ...dst,
    })
  }, [overlaySheetId, workspaceIdForOverlay])
  const [isTidying, setIsTidying] = useState(false)
  // Focused-subgraph mode: when a trace or runtime session is active, dim the
  // nodes that are off the active path so the investigation stays legible on a
  // large graph. User-toggleable; on by default.
  const [focusEnabled, setFocusEnabled] = useState(true)
  // Bumped whenever the layout is fully rebuilt, so overlay effects restamp.
  const [layoutVersion, setLayoutVersion] = useState(0)

  const tidyCanvas = useCallback(async () => {
    if (systems.length === 0 && infraNodes.length === 0) return
    setIsTidying(true)

    try {
      const finalPositions = runAlternateAxisLayout(systems, files, infraNodes, dependencies, new Map())

      const projId = currentProject?.id ?? ''
      const updatedSystems = [...systems]
      const updatedFiles = [...files]
      const updatedInfra = [...infraNodes]

      const apiPromises: Promise<any>[] = []

      for (const [id, pos] of finalPositions.entries()) {
        const sysIndex = updatedSystems.findIndex(s => s.id === id)
        if (sysIndex !== -1) {
          const stored = updatedSystems[sysIndex]
          const updated = {
            ...stored,
            positionX: pos.x,
            positionY: pos.y,
            width: pos.w,
            height: pos.h,
          }
          updatedSystems[sysIndex] = updated
          apiPromises.push(apiUpdateSystem(updated))
          if (projId) {
            apiPromises.push(apiSaveNodePosition(id, pos.x, pos.y, projId, 'system'))
          }
          continue
        }

        const fileIndex = updatedFiles.findIndex(f => f.id === id)
        if (fileIndex !== -1) {
          const stored = updatedFiles[fileIndex]
          const updated = {
            ...stored,
            positionX: pos.x,
            positionY: pos.y,
          }
          updatedFiles[fileIndex] = updated
          if (projId) {
            apiPromises.push(apiSaveNodePosition(id, pos.x, pos.y, projId, 'file'))
          }
          continue
        }

        const infraIndex = updatedInfra.findIndex(inf => inf.id === id)
        if (infraIndex !== -1) {
          const stored = updatedInfra[infraIndex]
          const updated = {
            ...stored,
            positionX: pos.x,
            positionY: pos.y,
          }
          updatedInfra[infraIndex] = updated
          continue
        }
      }

      // Force the next layout pass to treat it as first layout so it uses DB positions
      layoutBuiltRef.current = null

      // Update Zustand store
      useGraphStore.setState({
        systems: updatedSystems,
        files: updatedFiles,
        infraNodes: updatedInfra,
      })

      // Wait for all API updates to persist
      await Promise.all(apiPromises)

      // Fit the view to show the new layout
      queueCameraFit(100, { padding: 0.2, duration: 900, maxZoom: 1.0 })
    } catch (err) {
      console.error('[AxiomCanvas] Tidy layout failed', err)
    } finally {
      setIsTidying(false)
    }
  }, [systems, files, infraNodes, dependencies, currentProject, queueCameraFit])

  const tidyFrame = useCallback(async () => {
    const all = displayNodesRef.current
    const selectedContainer = selectedNodeId
      ? all.find(node => node.id === selectedNodeId && node.type === 'system')
      : undefined
    const scopeId = selectedContainer?.id ?? null
    const children = all.filter(node => (node.parentId ?? null) === scopeId && node.draggable !== false)
      .sort((a, b) => a.id.localeCompare(b.id))
    if (children.length === 0) return
    setIsTidying(true)
    try {
      const containerData = selectedContainer?.data as Record<string, unknown> | undefined
      const parentScale = selectedContainer ? Number(containerData?.worldScale ?? 1) : 1
      // Children are authored in the container's CONTENT space, so every child
      // quantity converts through contentScale while the container's own box
      // converts through its own world scale.
      const parentContentScale = selectedContainer ? Number(containerData?.contentScale ?? parentScale) : 1
      const parentInterior = selectedContainer ? Number(containerData?.interiorScale ?? 1) : 1
      const parentCanonical = selectedContainer ? {
        width: Number(selectedContainer.style?.width ?? selectedContainer.measured?.width ?? 1) / parentScale,
        height: Number(selectedContainer.style?.height ?? selectedContainer.measured?.height ?? 1) / parentScale,
      } : { width: 2600, height: 1800 }
      // The projected base is canonical already - dividing by world scale here
      // would reintroduce exactly the coupling the isolation removes.
      const ownContent = scopeId
        ? contentRectFor(parentCanonical, Number(containerData?.depth ?? 0), parentScale)
        : { x: 80, y: 80, width: parentCanonical.width - 160, height: parentCanonical.height - 160 }
      // Express the content box in the space the children are actually stored in.
      const content = {
        x: ownContent.x / parentInterior,
        y: ownContent.y / parentInterior,
        width: ownContent.width / parentInterior,
        height: ownContent.height / parentInterior,
      }
      const packed = packFrame(
        children.map(child => ({
          id: child.id,
          width: Number(child.style?.width ?? child.measured?.width ?? BASE_FILE_W) / parentContentScale,
          height: Number(child.style?.height ?? child.measured?.height ?? BASE_FILE_H) / parentContentScale,
        })),
        {
          baseGap: FRAME_ITEM_GAP,
          aspect: content.width / Math.max(1, content.height),
        },
      )
      const positions = new Map<string, { x: number; y: number }>()
      for (const child of children) {
        const position = packed.positions.get(child.id)!
        positions.set(child.id, { x: content.x + position.x, y: content.y + position.y })
      }

      const sheet = useSheetStore.getState()
      if (reviewMode && saveReviewLayouts) {
        const updates: Array<Omit<FloorLayout, 'workspaceId' | 'updatedAt'>> = children.map(child => {
          const nodeType: FloorNodeType = systems.some(item => item.id === child.id) ? 'system' : 'file'
          const previous = floorLayouts.find(item => item.nodeId === child.id && item.nodeType === nodeType)
          const worldScale = Number((child.data as any).worldScale ?? previous?.scale ?? 1)
          const position = positions.get(child.id)!
          return {
            nodeId: child.id,
            nodeType,
            parentNodeId: scopeId,
            parentNodeType: scopeId ? 'system' : null,
            containmentKind: scopeId ? 'part_of' : 'root',
            positionX: position.x,
            positionY: position.y,
            width: previous?.width ?? Number(child.style?.width ?? BASE_FILE_W) / Math.max(0.0001, worldScale),
            height: previous?.height ?? Number(child.style?.height ?? BASE_FILE_H) / Math.max(0.0001, worldScale),
            scale: previous?.scale ?? Number((child.data as any).frameScale ?? 1),
            interiorScale: previous?.interiorScale ?? Number((child.data as any).interiorScale ?? 1),
          }
        })
        await saveReviewLayouts(updates)
      } else if (sheet.activeSheetId) {
        const mutations: SheetLayoutMutation[] = children.map(child => {
          const position = positions.get(child.id)!
          const nodeType: FloorNodeType = sheetSystemIds.has(child.id)
            ? 'system' : sheetFileIds.has(child.id) ? 'file' : 'infra'
          const previous = sheetEffectiveLayouts.find(layout => layout.nodeId === child.id)
          const data = child.data as Record<string, unknown>
          const worldScale = Number(data.worldScale ?? 1)
          const parentNodeType = scopeId ? (sheetInfraIds.has(scopeId) ? 'infra' : 'system') : null
          return {
            nodeId: child.id,
            nodeType,
            parentNodeId: scopeId,
            parentNodeType,
            containmentKind: parentNodeType === 'infra' ? 'hosted_by' : parentNodeType ? 'part_of' : 'root',
            positionX: position.x,
            positionY: position.y,
            width: previous?.width ?? Number(child.style?.width ?? BASE_FILE_W) / Math.max(0.0001, worldScale),
            height: previous?.height ?? Number(child.style?.height ?? BASE_FILE_H) / Math.max(0.0001, worldScale),
            scale: previous?.scale ?? Number(data.frameScale ?? 1),
            interiorScale: previous?.interiorScale ?? Number(data.interiorScale ?? 1),
          }
        })
        await sheet.updateLayoutsBatch(workspaceIdForOverlay, sheet.activeSheetId, mutations)
      } else {
        const graph = useGraphStore.getState()
        const workspaceId = graph.currentProject?.id
        if (!workspaceId) return
        const updates: Omit<FloorLayout, 'workspaceId' | 'updatedAt'>[] = children.map(child => {
          const nodeType: FloorNodeType = graph.systems.some(item => item.id === child.id)
            ? 'system' : graph.files.some(item => item.id === child.id) ? 'file' : 'infra'
          const previous = graph.floorLayouts.find(item => item.nodeId === child.id && item.nodeType === nodeType)
          const worldScale = Number((child.data as any).worldScale ?? previous?.scale ?? 1)
          const ownScale = previous?.scale ?? Number((child.data as any).frameScale ?? 1)
          const position = positions.get(child.id)!
          return {
            nodeId: child.id, nodeType, parentNodeId: scopeId,
            parentNodeType: scopeId ? (graph.infraNodes.some(item => item.id === scopeId) ? 'infra' : 'system') : null,
            containmentKind: scopeId ? (graph.infraNodes.some(item => item.id === scopeId) ? 'hosted_by' : 'part_of') : 'root',
            positionX: position.x, positionY: position.y,
            width: previous?.width ?? Number(child.style?.width ?? BASE_FILE_W) / Math.max(0.0001, worldScale),
            height: previous?.height ?? Number(child.style?.height ?? BASE_FILE_H) / Math.max(0.0001, worldScale),
            scale: ownScale,
            // Tidy rearranges a frame's contents; it says nothing about how the
            // children themselves compress theirs. Carry it through unchanged.
            interiorScale: previous?.interiorScale ?? Number((child.data as any).interiorScale ?? 1),
          }
        })
        await apiSaveFloorLayouts(workspaceId, updates)
        const saved = updates.map(update => ({ ...update, workspaceId, updatedAt: Date.now() }))
        const changed = new Set(saved.map(item => item.nodeType + ':' + item.nodeId))
        useGraphStore.setState(state => ({
          floorLayouts: [...state.floorLayouts.filter(item => !changed.has(item.nodeType + ':' + item.nodeId)), ...saved],
        }))
      }
      queueCameraFit(80, { padding: 0.2, duration: 900, maxZoom: 1.0 })
    } catch (error) {
      console.error('[AxiomCanvas] tidy frame failed', error)
    } finally {
      setIsTidying(false)
    }
  }, [queueCameraFit, selectedNodeId, workspaceIdForOverlay, sheetEffectiveLayouts, sheetSystemIds, sheetFileIds, sheetInfraIds, reviewMode, saveReviewLayouts, systems, floorLayouts])

  const zoomRafRef        = useRef<number | null>(null)
  const layoutBuiltRef = useRef<string | null>(null)
  const initialFloorPersistRef = useRef<string | null>(null)
  const incrementalFloorPersistRef = useRef<string | null>(null)
  const reviewLayoutPersistRef = useRef<string | null>(null)
  const reviewLayoutPersistingSceneRef = useRef<string | null>(null)
  const [reviewLayoutPersistenceRevision, setReviewLayoutPersistenceRevision] = useState(0)
  const [interactionProjectionRevision, setInteractionProjectionRevision] = useState(0)
  // Remembered placements are per-workspace; carrying them across a project
  // switch would apply one project's coordinates to another's node ids.
  const placementScopeRef = useRef<string | null>(null)
  if (placementScopeRef.current !== sceneProjectId) {
    placementScopeRef.current = sceneProjectId
    floorPlacementsRef.current.clear()
    sheetPlacementsRef.current.clear()
  }
  const resizeStartRef    = useRef<Map<string, ResizeSessionStart>>(new Map())
  const resizingNodeIdRef = useRef<string | null>(null)
  // IDs are recorded from the actual React Flow changes, rather than inferred
  // from selection. That covers the resized node, compensated children, and
  // every member of a group resize without pinning unrelated scene updates.
  const resizeInteractionNodeIdsRef = useRef<Set<string>>(new Set())
  const rfNodesRef        = useRef<Node[]>([])
  const dropTargetRef     = useRef<string | null>(null)
  const draggingNodeIdRef = useRef<string | null>(null)
  const dragPositionRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  // XYFlow commits its internal node store asynchronously. Keep every emitted
  // absolute drag position outside React so the drop planner never reads the
  // previous frame, especially for secondary nodes in a multi-selection.
  const dragAbsolutePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  const resizePointerCleanupRef = useRef<(() => void) | null>(null)
  const dragTraceSessionRef = useRef(0)
  const dragTraceRef = useRef<NodeMoveTrace | null>(null)
  const targetZoomRef      = useRef<number | null>(null)
  const targetViewportRef  = useRef<{ x: number; y: number } | null>(null)
  const smoothZoomRafRef   = useRef<number | null>(null)
  const smoothZoomMouseRef = useRef<{ mx: number; my: number } | null>(null)

  rfNodesRef.current = rfNodes

  useEffect(() => () => {
    resizePointerCleanupRef.current?.()
    resizePointerCleanupRef.current = null
    if (zoomRafRef.current !== null) cancelAnimationFrame(zoomRafRef.current)
    zoomRafRef.current = null
    wheelLatchRef.current = null
  }, [])

  // ── Node resize ──────────────────────────────────────────────────────────
  const armResizeEndFallback = useCallback((nodeId: string) => {
    // XYFlow intentionally omits onResizeEnd when a handle is pressed and
    // released without a drag. Clear our interaction session after pointer-up
    // only if the normal end callback did not already consume it.
    resizePointerCleanupRef.current?.()
    const onPointerUp = () => {
      resizePointerCleanupRef.current?.()
      requestAnimationFrame(() => {
        if (!resizeStartRef.current.has(nodeId)) return
        resizeStartRef.current.delete(nodeId)
        resizeInteractionNodeIdsRef.current.clear()
        if (resizingNodeIdRef.current === nodeId) resizingNodeIdRef.current = null
        if (useSheetStore.getState().activeSheetId) setSheetInteractionNodes(null)
        setInteractionProjectionRevision(revision => revision + 1)
      })
    }
    resizePointerCleanupRef.current = () => {
      window.removeEventListener('pointerup', onPointerUp, true)
      resizePointerCleanupRef.current = null
    }
    window.addEventListener('pointerup', onPointerUp, { once: true, capture: true })
  }, [])

  const onNodeResizeEnd = useCallback((nodeId: string, end: NodeResizeParams) => {
    const start = resizeStartRef.current.get(nodeId)
    resizeStartRef.current.delete(nodeId)
    resizeInteractionNodeIdsRef.current.clear()
    requestAnimationFrame(() => {
      if (resizingNodeIdRef.current === nodeId) resizingNodeIdRef.current = null
      setInteractionProjectionRevision(revision => revision + 1)
    })
    if (!start) {
      if (useSheetStore.getState().activeSheetId) setSheetInteractionNodes(null)
      return
    }
    if (!resizeChanged(start, end)) {
      if (useSheetStore.getState().activeSheetId) setSheetInteractionNodes(null)
      return
    }

    // React Flow emits rendered, parent-local geometry; persistence uses
    // canonical geometry in the immediate parent's frame.
    const sheetState = useSheetStore.getState()
    const node = (!reviewMode && sheetState.activeSheetId ? displayNodesRef.current : rfNodesRef.current).find(n => n.id === nodeId)
    if (!node) {
      if (sheetState.activeSheetId) setSheetInteractionNodes(null)
      return
    }

    if (reviewMode && reviewScene && saveReviewLayouts) {
      const plan = planCanvasResize({
        workspaceId: reviewScene.workspaceId,
        nodeId,
        node,
        start,
        end,
        nodes: rfNodesRef.current,
        systemIds: new Set(systems.map(system => system.id)),
        fileIds: new Set(files.map(file => file.id)),
        infraIds: new Set(),
        floorLayouts,
      })
      if (plan.updates.every(update => reviewEditableNodeIds?.has(update.nodeId))) {
        void saveReviewLayouts(plan.updates).catch(error => {
          console.error('[AxiomCanvas] proposal resize failed', error)
        })
      }
      return
    }

    // Both surfaces use the exact same canonical resize planner. The only
    // difference is which sparse layout store receives its writes.
    if (sheetState.activeSheetId) {
      const plan = planCanvasResize({
        workspaceId: workspaceIdForOverlay,
        nodeId,
        node,
        start,
        end,
        nodes: displayNodesRef.current,
        systemIds: sheetSystemIds,
        fileIds: sheetFileIds,
        infraIds: sheetInfraIds,
        floorLayouts: sheetEffectiveLayouts,
      })
      if (plan.updates.length > 0) {
        void sheetState.updateLayoutsBatch(
          workspaceIdForOverlay,
          sheetState.activeSheetId,
          plan.updates,
        ).catch(() => {})
      }
      setSheetInteractionNodes(null)
      return
    }

    const graph = useGraphStore.getState()
    const workspaceId = graph.currentProject?.id
    if (!workspaceId) return
    const plan = planCanvasResize({
      workspaceId,
      nodeId,
      node,
      start,
      end,
      nodes: rfNodesRef.current,
      systemIds: new Set(graph.systems.map(system => system.id)),
      fileIds: new Set(graph.files.map(file => file.id)),
      infraIds: new Set(graph.infraNodes.map(infra => infra.id)),
      floorLayouts: graph.floorLayouts,
    })
    useGraphStore.setState(state => ({
      floorLayouts: replaceFloorLayouts(state.floorLayouts, plan.optimisticLayouts, plan.changedKeys),
    }))
    void apiSaveFloorLayouts(workspaceId, plan.updates).catch(error => {
      console.error('[AxiomCanvas] floor resize failed', error)
      useGraphStore.setState(state => ({
        floorLayouts: replaceFloorLayouts(state.floorLayouts, plan.previousLayouts, plan.changedKeys),
      }))
    })
  }, [workspaceIdForOverlay, sheetSystemIds, sheetFileIds, sheetInfraIds, sheetEffectiveLayouts, reviewMode, reviewScene?.workspaceId, reviewEditableNodeIds, saveReviewLayouts, systems, files, floorLayouts])

  const onNodeResizeEndRef = useRef(onNodeResizeEnd)
  onNodeResizeEndRef.current = onNodeResizeEnd

  const armResizeEndFallbackRef = useRef(armResizeEndFallback)
  armResizeEndFallbackRef.current = armResizeEndFallback

  const resizeHandlersRef = useRef(new Map<string, { onResizeStart: (p: NodeResizeParams) => void; onResizeEnd: (p: NodeResizeParams) => void }>())
  const getResizeHandlers = useCallback((nodeId: string, isSheet = false) => {
    const key = `${nodeId}:${isSheet ? 'sheet' : 'canvas'}`
    let handlers = resizeHandlersRef.current.get(key)
    if (!handlers) {
      const onResizeStart = (params: NodeResizeParams) => {
        setIsTransitioningLayout(false)
        resizingNodeIdRef.current = nodeId
        draggingNodeIdRef.current = null
        dragPositionRef.current.delete(nodeId)
        const sourceNodes = isSheet ? displayNodesRef.current : rfNodesRef.current
        const children = new Map(sourceNodes
          .filter(child => child.parentId === nodeId)
          .map(child => [child.id, { x: child.position.x, y: child.position.y }]))
        resizeInteractionNodeIdsRef.current = new Set([nodeId, ...children.keys()])
        resizeStartRef.current.set(nodeId, { ...params, children })
        armResizeEndFallbackRef.current?.(nodeId)
        if (isSheet) {
          setSheetInteractionNodes(current => current ?? displayNodesRef.current)
        }
      }
      const onResizeEnd = (params: NodeResizeParams) => onNodeResizeEndRef.current?.(nodeId, params)
      handlers = { onResizeStart, onResizeEnd }
      resizeHandlersRef.current.set(key, handlers)
    }
    return handlers
  }, [])


  useEffect(() => {
    if (deferCanvasMaterialization) {
      pendingInitialFitProjectRef.current = null
      setRfNodes(current => current.length === 0 ? current : [])
      setRfEdges(current => current.length === 0 ? current : [])
      return
    }
    // The map must always show every file. A fresh project (agent building into
    // an empty folder) has files before any system exists - render them at the
    // top level rather than an empty Floor; live classification groups them into
    // systems as the topology emerges.
    if (systems.length === 0 && infraNodes.length === 0 && files.length === 0) return

    const projectId = sceneProjectId
    // On first layout for a project, don't use existing positions - force fresh grid layout.
    // On subsequent data updates (same project), preserve user-dragged positions.
    const isFirstLayout = layoutBuiltRef.current !== projectId
    const {
      rfNodes: layout,
      rfEdges: newEdges,
      generatedLayoutNodeIds,
      resizedContainerIds,
    } = buildFloorFrameLayout(
      systems, files, infraNodes, dependencies, floorLayouts,
      currentZoomRef.current, floorPlacementsRef.current,
    )
    const filesByIdForPersistence = new Map(files.map(file => [file.id, file]))
    const systemIdsForPersistence = new Set(systems.map(system => system.id))
    const infraIdsForPersistence = new Set(infraNodes.map(infra => infra.id))

    const serializeFloorNode = (node: Node): Omit<FloorLayout, 'workspaceId' | 'updatedAt'> => {
      const nodeType: FloorNodeType = systemIdsForPersistence.has(node.id)
        ? 'system' : filesByIdForPersistence.has(node.id) ? 'file' : 'infra'
      const ownScale = Number((node.data as any).frameScale ?? 1)
      const worldScale = Number((node.data as any).worldScale ?? ownScale)
      // The parent factor that produced this node's world position is the
      // parent's CONTENT scale; dividing it back out recovers canonical coords.
      const parentWorldScale = node.parentId ? worldScale / Math.max(0.0001, ownScale) : 1
      const parentNodeType = node.parentId
        ? (infraIdsForPersistence.has(node.parentId) ? 'infra' : 'system')
        : null
      return {
        nodeId: node.id,
        nodeType,
        parentNodeId: node.parentId ?? null,
        parentNodeType,
        containmentKind: parentNodeType === 'infra' ? 'hosted_by' : parentNodeType === 'system' ? 'part_of' : 'root',
        positionX: node.position.x / Math.max(0.0001, parentWorldScale),
        positionY: node.position.y / Math.max(0.0001, parentWorldScale),
        width: Number(node.style?.width ?? node.measured?.width ?? 1) / Math.max(0.0001, worldScale),
        height: Number(node.style?.height ?? node.measured?.height ?? 1) / Math.max(0.0001, worldScale),
        scale: ownScale,
        interiorScale: Number((node.data as any).interiorScale ?? 1),
      }
    }

    // A genuinely empty Floor gets one relationship-aware initialization.
    // Persist the complete result immediately; after this, authored freeform
    // geometry is the sole source of truth and the force layout never reruns.
    // Only freeze an initial layout once real containers exist. Persisting root
    // positions for still-unclassified files would pin them, blocking live
    // classification from later moving them into their system.
    const everyFileClassified = files.every(file => !!file.systemId)
    if (reviewMode && saveReviewLayouts && reviewEditableNodeIds) {
      // The live Floor freezes every generated row before the first gesture.
      // Review must do the same. Leaving proposal geometry sparse meant the
      // first user move persisted one node, then every untouched node entered
      // fresh-packing again and the whole review appeared to tidy itself.
      const missingEditableIds = new Set(
        [...reviewEditableNodeIds].filter(id => !floorLayouts.some(layoutRow => layoutRow.nodeId === id)),
      )
      for (const id of resizedContainerIds) {
        if (reviewEditableNodeIds.has(id)) missingEditableIds.add(id)
      }
      const updates = layout
        .filter(node => missingEditableIds.has(node.id))
        .map(serializeFloorNode)
      if (updates.length > 0) {
        setReviewReadySceneId(current => current === projectId ? null : current)
        const signature = projectId + ':' + updates.map(update => [
          update.nodeType, update.nodeId, update.parentNodeId ?? '',
          update.positionX, update.positionY, update.width, update.height,
          update.scale, update.interiorScale,
        ].join(':')).sort().join('|')
        if (reviewLayoutPersistRef.current !== signature) {
          reviewLayoutPersistRef.current = signature
          reviewLayoutPersistingSceneRef.current = projectId
          void saveReviewLayouts(updates)
            .catch(error => {
              console.error('[AxiomCanvas] initial proposal layout failed', error)
            })
            .finally(() => {
              if (reviewLayoutPersistingSceneRef.current === projectId) {
                reviewLayoutPersistingSceneRef.current = null
              }
              setReviewLayoutPersistenceRevision(revision => revision + 1)
            })
        }
      } else if (reviewLayoutPersistingSceneRef.current !== projectId) {
        setReviewReadySceneId(current => current === projectId ? current : projectId)
      }
    } else if (!reviewMode && !binMode && !readOnly && currentProject && systems.length > 0 && everyFileClassified && floorLayouts.length === 0 && initialFloorPersistRef.current !== projectId) {
      initialFloorPersistRef.current = projectId
      const initialLayouts = layout.map(serializeFloorNode)
      const optimistic = initialLayouts.map(item => ({ ...item, workspaceId: currentProject.id, updatedAt: Date.now() }))
      useGraphStore.setState({ floorLayouts: optimistic })
      void apiSaveFloorLayouts(currentProject.id, initialLayouts).catch(error => {
        console.error('[AxiomCanvas] initial Floor layout failed', error)
        initialFloorPersistRef.current = null
        useGraphStore.setState({ floorLayouts: [] })
      })
    } else if (!reviewMode && !binMode && !readOnly && currentProject && floorLayouts.length > 0) {
      // Do not pin a just-created, still-unclassified file to the Floor root.
      // Its semantic parent arrives in the classifier's atomic snapshot.
      const persistableGeneratedIds = [...generatedLayoutNodeIds].filter(nodeId => {
        const file = filesByIdForPersistence.get(nodeId)
        const nodeType: FloorNodeType = file ? 'file' : systemIdsForPersistence.has(nodeId) ? 'system' : 'infra'
        return canPersistGeneratedFrame(nodeType, file?.systemId ?? null)
      })
      const reconciledIds = new Set([...persistableGeneratedIds, ...resizedContainerIds])
      const updates = layout.filter(node => reconciledIds.has(node.id)).map(serializeFloorNode)
      if (updates.length > 0) {
        const signature = currentProject.id + ':' + updates
          // Every field the write actually changes. Omitting one makes a real
          // change look like a repeat and get skipped - `interiorScale` and
          // `containmentKind` were both missing.
          .map(update => [
            update.nodeType, update.nodeId, update.parentNodeId ?? '', update.parentNodeType ?? '',
            update.containmentKind, update.positionX, update.positionY,
            update.width, update.height, update.scale, update.interiorScale,
          ].join(':'))
          .sort()
          .join('|')
        if (incrementalFloorPersistRef.current !== signature) {
          incrementalFloorPersistRef.current = signature
          const changedKeys = new Set(updates.map(update => update.nodeType + ':' + update.nodeId))
          const previousLayouts = floorLayouts.filter(item => changedKeys.has(item.nodeType + ':' + item.nodeId))
          const optimistic = updates.map(update => ({
            ...update,
            workspaceId: currentProject.id,
            updatedAt: Date.now(),
          }))
          useGraphStore.setState(state => ({
            floorLayouts: replaceFloorLayouts(state.floorLayouts, optimistic, changedKeys),
          }))
          void apiSaveFloorLayouts(currentProject.id, updates).catch(error => {
            console.error('[AxiomCanvas] incremental Floor reconciliation failed', error)
            useGraphStore.setState(state => ({
              floorLayouts: replaceFloorLayouts(state.floorLayouts, previousLayouts, changedKeys),
            }))
          })
        }
      }
    }

    const layoutWithCallbacks = layout.map(n => {
      const handlers = readOnly || (reviewMode && !reviewLayoutReady) ? undefined : getResizeHandlers(n.id, false)
      return {
        ...n,
        draggable: reviewMode
          ? reviewLayoutReady && (reviewEditableNodeIds?.has(n.id) ?? false)
          : n.draggable,
        selectable: true,
        data: {
          ...n.data,
          onResizeStart: handlers?.onResizeStart,
          onResizeEnd: handlers?.onResizeEnd,
        },
      }
    })
    // A large first projection is about to be fitted to an overview. Starting
    // its semantic tier at the default 0.5x would briefly mount every child of
    // a large root before fitView reaches the real overview zoom - exactly the
    // expensive flash this path is meant to prevent.
    const visibilityZoom = isFirstLayout && layout.length > LARGE_SCENE_NODE_COUNT
      ? MIN_CANVAS_ZOOM
      : currentZoomRef.current
    const gestureSafeLayout = resizeStartRef.current.size > 0
      ? preserveActiveResizeGeometry(
          layoutWithCallbacks,
          rfNodesRef.current,
          resizeInteractionNodeIdsRef.current,
        )
      : layoutWithCallbacks
    const withZoom = reviewMode
      ? gestureSafeLayout.map(makeFullyVisible)
      : applyZoomVisibility(gestureSafeLayout, visibilityZoom)
    const fixed = stampSelection(withZoom, selectedIdsRef.current)
    sceneSourceRef.current = isFirstLayout ? 'layout-build' : 'layout-rebuild'
    setRfNodes(fixed)
    setRfEdges(newEdges)
    // Signal overlay effects (runtime / focus / trace) to restamp their
    // per-node flags, which this full rebuild just discarded.
    setLayoutVersion(v => v + 1)

    if (isFirstLayout) {
      layoutBuiltRef.current = projectId
      pendingInitialFitProjectRef.current = projectId
    }
  }, [systems, files, infraNodes, floorLayouts, dependencies, getResizeHandlers, readOnly, deferCanvasMaterialization, reviewMode, reviewLayoutReady, reviewEditableNodeIds, saveReviewLayouts, reviewLayoutPersistenceRevision, interactionProjectionRevision, sceneProjectId])

  // The first camera used to be an 80ms guess after setRfNodes. That raced both
  // React Flow measurement and the immediate persisted-layout reprojection, so
  // unrelated mount work could decide which bounds fitView observed. Sample
  // the complete internal scene until its absolute measured geometry is stable
  // across consecutive frames, then fit exactly once for this project.
  useEffect(() => {
    const fitNodes = rfNodes.filter(node => !node.hidden)
    if (!nodesInitialized || pendingInitialFitProjectRef.current !== sceneProjectId || fitNodes.length === 0) {
      return
    }

    let frame = 0
    let measurement = { signature: null as string | null, stableFrames: 0 }
    const sampleMeasuredScene = () => {
      if (pendingInitialFitProjectRef.current !== sceneProjectId) return

      const parts: string[] = []
      for (const node of fitNodes) {
        const internal = getInternalNode(node.id)
        const width = internal?.measured.width
        const height = internal?.measured.height
        const position = internal?.internals.positionAbsolute
        if (!position || !width || !height) {
          measurement = advanceSceneMeasurement(measurement, null)
          frame = requestAnimationFrame(sampleMeasuredScene)
          return
        }
        parts.push(`${node.id}:${position.x},${position.y},${width},${height}`)
      }
      parts.sort()
      measurement = advanceSceneMeasurement(measurement, parts.join('|'))
      if (!sceneMeasurementIsSettled(measurement)) {
        frame = requestAnimationFrame(sampleMeasuredScene)
        return
      }

      if (runningInitialFitProjectRef.current === sceneProjectId) return
      runningInitialFitProjectRef.current = sceneProjectId
      // maxZoom keeps a sparse Floor from filling the viewport. The short
      // authored entrance completes well before the canvas is interactive.
      void fitView({
        nodes: fitNodes.map(node => ({ id: node.id })),
        padding: 0.25,
        duration: 400,
        maxZoom: 1.0,
      }).finally(() => {
        if (runningInitialFitProjectRef.current === sceneProjectId) {
          runningInitialFitProjectRef.current = null
        }
        if (pendingInitialFitProjectRef.current !== sceneProjectId) return
        pendingInitialFitProjectRef.current = null
        const settledZoom = getViewport().zoom
        currentZoomRef.current = settledZoom
        lastVisibilityZoomRef.current = settledZoom
        sceneSourceRef.current = 'initial-fit-visibility'
        setRfNodes(current => reviewMode
          ? current.map(makeFullyVisible)
          : applyZoomVisibility(current, settledZoom))
      })
    }

    frame = requestAnimationFrame(sampleMeasuredScene)
    return () => cancelAnimationFrame(frame)
  }, [fitView, getInternalNode, getViewport, nodesInitialized, rfNodes, sceneProjectId, reviewMode])

  // Live reframing - as files stream in from the watcher, gently fit the growing
  // graph so new nodes come into view at a sensible zoom, instead of leaving the
  // camera parked on the first node. Skips the initial 0→N population (handled by
  // the first-layout fit) and yields while the user is actively navigating.
  useEffect(() => {
    const count = systems.length + files.length + infraNodes.length
    const prev = liveNodeCountRef.current
    liveNodeCountRef.current = count
    if (suppressGrowthFitRef.current) {
      // Consumed once: the baseline above is already updated, so the next real
      // growth still reframes normally.
      suppressGrowthFitRef.current = false
      return
    }
    if (deferCanvasMaterialization || reviewMode) return
    if (prev === 0 || count <= prev) return
    queueCameraFit(1800, { padding: 0.28, duration: 1100, maxZoom: 1.0 })
  }, [systems.length, files.length, infraNodes.length, queueCameraFit, deferCanvasMaterialization, reviewMode])

  // Revealing a node from outside the canvas - search, the agent log, the
  // detail panel - selects it, exactly as clicking it would.
  //
  // This used to paint `selected` straight onto the scene without telling the
  // authoritative set, so the canvas and the set disagreed from that moment on:
  // the highlight said one thing, and the next drag acted on another. It also
  // fired on every change of the pointer, including to null, silently wiping a
  // multi-selection the user had just made. A null pointer now means "no single
  // node is current" - a group has no single node - and clears nothing.
  useEffect(() => {
    if (!selectedNodeId) return
    const current = selectedIdsRef.current
    if (current.size === 1 && current.has(selectedNodeId)) return
    applySelection(singleNodeSelection(selectedNodeId))
  }, [selectedNodeId, applySelection])

  // ── Runtime activity ─────────────────────────────────────────────────────
  // Stamp live runtime state (watch markers, call counts, pulse triggers)
  // onto the affected file nodes. runtimeNodes only contains watched files,
  // so untouched nodes keep referential identity and skip re-render.
  useEffect(() => {
    setRfNodes(curr => curr.map(n => {
      const rt = runtimeNodes[n.id]
      const had = (n.data as any).runtime
      if (!rt && !had) return n
      if (rt === had) return n
      return { ...n, data: { ...n.data, runtime: rt ?? null } }
    }))
  }, [runtimeNodes, layoutVersion])

  // ── Data-flow slice (purple overlay) ───────────────────────────────────────
  // Stamp `sliced` on file nodes in the current variable-reference slice.
  useEffect(() => {
    const ids = dataFlow?.fileIds ?? null
    setRfNodes(curr => curr.map(n => {
      const inSlice = !!ids && ids.has(n.id)
      return (n.data as any).sliced === inSlice ? n : { ...n, data: { ...n.data, sliced: inSlice } }
    }))
  }, [dataFlow, layoutVersion])

  // ── Focused subgraph ───────────────────────────────────────────────────────
  // The focus set = files in the active trace + files with runtime activity,
  // plus their ancestor systems (so a focused file's containers stay lit).
  // Everything else is dimmed. Off when nothing is active or the user disables it.
  // Stable content key: the SET of focused files changes only when a watch is
  // added/removed or the trace changes - not on every runtime metric tick. This
  // keeps the focus effect from re-running (and re-mapping all nodes) ~12×/sec.
  const focusKey = useMemo(() => {
    const ids: string[] = []
    if (activeTrace) {
      for (const step of activeTrace) { ids.push(step.callerFile); ids.push(step.calleeFile) }
    }
    ids.push(...Object.keys(runtimeNodes))
    return Array.from(new Set(ids)).sort().join('|')
  }, [activeTrace, runtimeNodes])

  const focusFileIds = useMemo(
    () => new Set(focusKey ? focusKey.split('|') : []),
    [focusKey],
  )

  useEffect(() => {
    const active = focusEnabled && focusFileIds.size > 0
    if (!active) {
      setRfNodes(curr => curr.some(n => (n.data as any).dimmed)
        ? curr.map(n => (n.data as any).dimmed ? { ...n, data: { ...n.data, dimmed: false } } : n)
        : curr)
      return
    }
    // Keep focused files and every ancestor system on their parent chain lit.
    const systemById = new Map(systems.map(s => [s.id, s]))
    const fileById = new Map(files.map(f => [f.id, f]))
    const keep = new Set<string>(focusFileIds)
    for (const fileId of focusFileIds) {
      let sysId = fileById.get(fileId)?.systemId ?? null
      while (sysId && !keep.has(sysId)) {
        keep.add(sysId)
        sysId = systemById.get(sysId)?.parentId ?? null
      }
    }
    setRfNodes(curr => curr.map(n => {
      const dim = !keep.has(n.id)
      return (n.data as any).dimmed === dim ? n : { ...n, data: { ...n.data, dimmed: dim } }
    }))
  }, [focusEnabled, focusFileIds, systems, files, layoutVersion])

  // ── Call trace ───────────────────────────────────────────────────────────
  // When the agent queries a call path, stamp isTraced on the involved file nodes
  // and inject glowing directed edges between consecutive steps.
  useEffect(() => {
    if (!activeTrace || activeTrace.length === 0) {
      setRfNodes(curr => curr.map(n =>
        (n.data as any).isTraced ? { ...n, data: { ...n.data, isTraced: false } } : n
      ))
      setRfEdges(curr => curr.filter(e => !e.id.startsWith('trace-')))
      return
    }

    const tracedIds = new Set<string>()
    activeTrace.forEach(step => {
      tracedIds.add(step.callerFile)
      tracedIds.add(step.calleeFile)
    })

    setRfNodes(curr => curr.map(n => ({
      ...n,
      data: { ...n.data, isTraced: tracedIds.has(n.id) },
    })))

    const traceEdges: Edge[] = activeTrace.map((step, i) => ({
      id: `trace-${step.callerFile}-${step.calleeFile}-${i}`,
      source: step.callerFile,
      target: step.calleeFile,
      className: 'trace-edge',
      style: { stroke: '#22d3ee', strokeWidth: 2 },
      label: step.callerSymbol && step.calleeSymbol
        ? `${step.callerSymbol} · ${step.calleeSymbol}`
        : undefined,
      labelStyle: { fill: '#22d3ee', fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: 'rgba(10,13,20,0.85)', rx: 4 },
      zIndex: 1000,
    }))
    setRfEdges(curr => [...curr.filter(e => !e.id.startsWith('trace-')), ...traceEdges])
  }, [activeTrace, layoutVersion])

  // ── WASD pan ────────────────────────────────────────────────────────────
  // Keyboard panning listens on the window, so every mounted canvas would
  // answer the same keypress. Only the Floor owns WASD; the bin is navigated
  // by dragging it, which is unambiguous about which surface you meant.
  // WASD follows the pointer: whichever canvas you are hovering is the one
  // that pans. The Floor is the fallback for when the pointer is over neither
  // (a toolbar, a side panel), so the keys never simply stop working.
  const wasdScope = useMemo(() => ({
    element: () => canvasRootRef.current,
    fallback: !binMode,
  }), [binMode])
  useCanvasWasdPan(getViewport, setViewport, true, wasdScope)

  useEffect(() => {
    if (readOnly || !overlaySheetId || !selectedNodeId) return
    const onDeleteSelectedSheetNode = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return

      const planned = activePlannedByNodeId.get(selectedNodeId)
      const element = activeElementByNodeId.get(selectedNodeId)
      if (!planned && !element) return

      event.preventDefault()
      event.stopPropagation()
      setSelectedNode(null)
      setInspectedNode(null)
      if (planned?.id === infraPickerNodeId) setInfraPickerNode(null)
      if (planned) {
        void useSheetStore.getState().deletePlanned(workspaceIdForOverlay, planned.id)
          .catch(error => console.error('[sheets] failed to delete selected planned node:', error))
      } else if (element) {
        void useSheetStore.getState().removeElement(
          workspaceIdForOverlay, overlaySheetId, element.id,
        ).catch(error => console.error('[sheets] failed to remove selected live node:', error))
      }
    }
    window.addEventListener('keydown', onDeleteSelectedSheetNode)
    return () => window.removeEventListener('keydown', onDeleteSelectedSheetNode)
  }, [readOnly, overlaySheetId, selectedNodeId, activePlannedByNodeId, activeElementByNodeId, workspaceIdForOverlay, setSelectedNode, setInspectedNode, setInfraPickerNode, infraPickerNodeId])

  useEffect(() => {
    return () => {
      if (smoothZoomRafRef.current !== null) {
        cancelAnimationFrame(smoothZoomRafRef.current)
      }
    }
  }, [])

  const handleWheel = useCallback((e: WheelEvent) => {
    // This canvas consumes the gesture, whatever it decides to do with it.
    //
    // The bin window is positioned against the viewport but is still a DOM
    // descendant of the Floor, so without this a wheel over the bin bubbled
    // into the Floor's listener and zoomed both canvases at once. Stopping
    // here means the surface under the cursor is the only one that answers.
    e.stopPropagation()
    // Scrollable node content (symbol lists, class members) gets the wheel
    // while it can still scroll; the canvas takes over at the boundary.
    const route = routeWheelEvent(
      e.target as Element | null,
      e.deltaY,
      canvasRootRef.current,
      element => {
        const style = window.getComputedStyle(element)
        return {
          overflowY: style.overflowY,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        }
      },
    )
    if (route.kind === 'ignore') return

    // Scroll latching. Once a gesture is scrolling a list it keeps that list
    // until the user actually stops, even after hitting an end. Without this,
    // running out of list mid-flick hands the rest of the same gesture to the
    // canvas and it scrolls and zooms at once.
    const now = e.timeStamp
    const latched = wheelLatchRef.current
    const latchedElement = latched && now - latched.lastEventAt < WHEEL_LATCH_MS &&
      latched.element.isConnected
      ? latched.element
      : null
    const scrollElement = latchedElement ??
      (route.kind === 'scroll' ? route.element : null)

    if (scrollElement) {
      // Consume it outright. Native scrolling is unreliable inside a
      // transform-scaled node, and any other wheel listener acting on the same
      // event would fight Axiom's zoom.
      e.preventDefault()
      e.stopPropagation()
      wheelLatchRef.current = { element: scrollElement, lastEventAt: now }
      // A gesture that began before the latch may have started a smooth zoom
      // that keeps easing for many frames. It must die here.
      if (smoothZoomRafRef.current !== null) {
        cancelAnimationFrame(smoothZoomRafRef.current)
        smoothZoomRafRef.current = null
      }
      targetZoomRef.current = null
      targetViewportRef.current = null
      scrollElement.scrollTop += wheelScrollStep(e.deltaY, scrollElement.clientHeight)
      return
    }
    wheelLatchRef.current = null

    e.preventDefault()

    const currentViewport = getViewport()
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    smoothZoomMouseRef.current = { mx, my }

    // Initialize targetZoom if not set or if it has converged
    if (targetZoomRef.current === null) {
      targetZoomRef.current = currentViewport.zoom
    }

    targetZoomRef.current = nextWheelZoomTarget(targetZoomRef.current, e.deltaY)

    // Start the animation loop if it's not already running
    if (smoothZoomRafRef.current === null) {
      const ease = () => {
        const vp = getViewport()
        const tz = targetZoomRef.current
        const mouse = smoothZoomMouseRef.current

        if (tz === null || mouse === null) {
          smoothZoomRafRef.current = null
          return
        }

        const nextViewport = easeViewportTowardZoom(vp, { x: mouse.mx, y: mouse.my }, tz)
        setViewport(nextViewport)

        // Stop the animation if we are very close to target zoom
        if (Math.abs(nextViewport.zoom - tz) < ZOOM_SNAP_EPSILON) {
          // Final snap
          const finalVp = getViewport()
          setViewport(zoomViewportAroundPoint(finalVp, { x: mouse.mx, y: mouse.my }, tz))

          targetZoomRef.current = null
          smoothZoomRafRef.current = null
        } else {
          smoothZoomRafRef.current = requestAnimationFrame(ease)
        }
      }
      smoothZoomRafRef.current = requestAnimationFrame(ease)
    }
  }, [getViewport, setViewport])

  useEffect(() => {
    const element = canvasRootRef.current
    if (!element) return
    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const onMove: OnMove = useCallback((event, viewport) => {
    const zoom = viewport.zoom
    currentZoomRef.current = zoom
    // Keep the conservative overview tier throughout the entrance animation.
    // Once fitView settles, its completion handler applies the final zoom once.
    const visibilityZoom = pendingInitialFitProjectRef.current
      ? MIN_CANVAS_ZOOM
      : zoom

    // A sheet interaction snapshot must never outlive the geometry mutation
    // that created it, or it freezes semantic zoom on stale node styles.
    if (useSheetStore.getState().activeSheetId && !draggingNodeIdRef.current && resizeStartRef.current.size === 0) {
      setSheetInteractionNodes(null)
    }

    // Cancel smooth zoom animation if movement is driven by user interaction (drag, pinch, etc.)
    if (event) {
      lastUserMoveAtRef.current = Date.now()
      if (smoothZoomRafRef.current !== null) {
        cancelAnimationFrame(smoothZoomRafRef.current)
        smoothZoomRafRef.current = null
      }
      targetZoomRef.current = null
      targetViewportRef.current = null
    }

    if (zoomRafRef.current) cancelAnimationFrame(zoomRafRef.current)
    zoomRafRef.current = requestAnimationFrame(() => {
      const draggingId = draggingNodeIdRef.current
      // Panning (zoom unchanged) never alters semantic visibility. Restamping
      // every node on each pan frame is what made panning feel janky - skip it
      // unless the zoom actually changed (or a node is being dragged).
      if (!draggingId && Math.abs(visibilityZoom - lastVisibilityZoomRef.current) < 1e-4) return
      lastVisibilityZoomRef.current = visibilityZoom
      sceneSourceRef.current = 'zoom-visibility'
      setRfNodes(curr => {
        let updated = reviewMode ? curr.map(makeFullyVisible) : applyZoomVisibility(curr, visibilityZoom)
        if (draggingId) {
          updated = updated.map(n => n.id === draggingId ? makeFullyVisible(n) : n)
        }
        return updated
      })
    })
  }, [reviewMode])

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      const { interaction, rejectedStructural } = partitionCanvasNodeChanges(changes)
      if (rejectedStructural.length > 0) {
        console.error('[scene-integrity] rejected structural React Flow changes', {
          projectId: useGraphStore.getState().currentProject?.id ?? 'demo',
          canonicalNodeCount:
            useGraphStore.getState().systems.length +
            useGraphStore.getState().files.length +
            useGraphStore.getState().infraNodes.length,
          sceneNodeCount: displayNodesRef.current.length,
          // 'add' changes carry the whole node instead of a bare id, so the id
          // has to be read defensively or this diagnostic throws while
          // reporting the very corruption it exists to catch.
          changes: rejectedStructural.map(change => ({
            type: change.type,
            id: 'id' in change ? change.id : change.item?.id ?? null,
          })),
        })
      }
      if (interaction.length === 0) return
      if (resizeStartRef.current.size > 0) {
        for (const change of interaction) {
          if (change.type === 'position' || change.type === 'dimensions') {
            resizeInteractionNodeIdsRef.current.add(change.id)
          }
        }
      }
      if (draggingNodeIdRef.current) {
        for (const change of interaction) {
          if (change.type === 'position' && change.positionAbsolute) {
            dragAbsolutePositionsRef.current.set(change.id, {
              x: change.positionAbsolute.x,
              y: change.positionAbsolute.y,
            })
          }
        }
      }
      const moveTrace = dragTraceRef.current
      if (moveTrace) {
        const viewport = getViewport()
        const now = performance.now()
        for (const change of interaction) {
          if (change.type !== 'position') continue
          const previous = moveTrace.previousChangeByNodeId.get(change.id)
          const x = change.position?.x ?? null
          const y = change.position?.y ?? null
          moveTrace.changeRows.push({
            sample: moveTrace.changeRows.length + 1,
            tMs: now - moveTrace.startedAt,
            nodeId: change.id,
            primaryNode: change.id === moveTrace.nodeId,
            dragging: change.dragging ?? null,
            zoom: viewport.zoom,
            emittedX: x,
            emittedY: y,
            emittedAbsoluteX: change.positionAbsolute?.x ?? null,
            emittedAbsoluteY: change.positionAbsolute?.y ?? null,
            deltaFromPreviousX: x !== null && previous ? x - previous.x : null,
            deltaFromPreviousY: y !== null && previous ? y - previous.y : null,
            screenDeltaFromPreviousX: x !== null && previous ? (x - previous.x) * viewport.zoom : null,
            screenDeltaFromPreviousY: y !== null && previous ? (y - previous.y) * viewport.zoom : null,
          })
          if (x !== null && y !== null) moveTrace.previousChangeByNodeId.set(change.id, { x, y })
        }
      }
      commitSelection(selectionAfterNodeChanges(selectedIdsRef.current, interaction))
      // North/west resize handles change the frame origin as well as its
      // dimensions. Apply the complete React Flow change set so the edge under
      // the pointer remains under the pointer and child compensation stays live.
      const interactionChanges = interaction
      // Planned overlay nodes live in the sheet store, not rfNodes - route
      // their drags there and keep the rest on the normal path.
      if (overlaySheetId) {
        const geometryChanges = interactionChanges.filter(change => change.type === 'position' ||
          (change.type === 'dimensions' && resizeStartRef.current.size > 0))
        if (geometryChanges.length > 0) {
          setSheetInteractionNodes(nodes => applyNodeChanges(geometryChanges, nodes ?? displayNodesRef.current))
        }
      } else {
        sceneSourceRef.current = 'react-flow-interaction'
        setRfNodes(nodes => applyNodeChanges(interactionChanges, nodes))
      }
    }, [getViewport, overlaySheetId]
  )
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setRfEdges(es => applyEdgeChanges(changes, es)), []
  )

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    // By the time this runs, the press has ALREADY been turned into a selection
    // - React Flow applies the platform-standard rule on pointer down (plain
    // press replaces, modifier press toggles) and those changes have already
    // flowed through onNodesChange into the authoritative set.
    //
    // So this handler adopts that outcome; it must not re-derive it. Computing
    // the toggle a second time here undid the first one, which is exactly why a
    // modifier click looked like it did nothing at all. A plain click hid the
    // problem because replacing a selection twice lands in the same place.
    //
    // Re-stamping the same set is not redundant: on a sheet, select changes do
    // not reach the interaction snapshot, so this is what repaints it.
    const selection = new Set(selectedIdsRef.current)
    applySelection(selection)
    // The store's node pointer follows the selection rather than pinning it: it
    // is what the detail panel and the agent dialog read, so it should name the
    // node just acted on, and nothing at all once a group is in play.
    setSelectedNode(selection.size === 1 ? [...selection][0] : null)
    const target = event.target as HTMLElement | null
    if (!target?.closest('input, textarea, select, button, [contenteditable="true"], [data-node-editable="true"]')) {
      setInspectedNode(null)
    }
  }, [applySelection, setSelectedNode, setInspectedNode])

  const onNodeDoubleClick = useCallback((event: React.MouseEvent, node: Node) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, select, button, [contenteditable="true"], [data-node-editable="true"]')) return
    setSelectedNode(node.id)
    setInspectedNode(node.id)
  }, [setSelectedNode, setInspectedNode])

  const onPaneClick = useCallback(() => {
    applySelection(emptySelection())
    setSelectedNode(null)
    setInspectedNode(null)
  }, [applySelection, setSelectedNode, setInspectedNode])

  // ── Drag visibility override ─────────────────────────────────────────────
  const onNodeDragStart: OnNodeDrag = useCallback((event, node) => {
    if (resizingNodeIdRef.current === node.id) return
    setIsTransitioningLayout(false)
    setIsDraggingScene(true)
    // A drag out of the bin ends outside the canvas that started it, which is
    // not a gesture React Flow models: released over the Floor, its drag never
    // terminated and the node stayed glued to the cursor. Released back over
    // the bin it ended normally - the asymmetry that gave this away.
    //
    // So the bin owns the terminating event itself. Bound on the window in the
    // capture phase, it fires wherever the pointer happens to be.
    if (binMode) beginBinDrag(node.id)
    else if (!readOnly) beginFloorBinDrag(node.id)
    // Grabbing a node that was not part of the selection makes it the whole
    // selection, before anything reads the group this gesture will move. A drag
    // never silently carries along whatever was selected beforehand. React Flow
    // reaches the same conclusion through its own select changes; committing it
    // here keeps Axiom's authoritative set from lagging a frame behind them.
    //
    // Held modifier means the press was building a selection, not starting a
    // fresh gesture - including a press that just toggled this node OUT. Reset
    // it there and the node the user was deselecting snaps back on the smallest
    // jitter of the mouse.
    if (!isAdditiveEvent(event) && !selectedIdsRef.current.has(node.id)) {
      applySelection(selectionAfterDragStart(selectedIdsRef.current, node.id))
      setSelectedNode(node.id)
    }
    draggingNodeIdRef.current = node.id
    dragPositionRef.current.set(node.id, { x: node.position.x, y: node.position.y })
    dragAbsolutePositionsRef.current.clear()
    const startingInternal = getInternalNode(node.id)
    dragAbsolutePositionsRef.current.set(
      node.id,
      startingInternal?.internals.positionAbsolute ?? node.position,
    )
    // Forcing the dragged node fully visible is drag BEHAVIOR, not
    // instrumentation, so it has to run before the tracing gate below. A
    // semantically faded node keeps `pointerEvents: none`, and a node that
    // cannot receive its own pointerup never ends its drag - it just follows
    // the cursor until the app is reloaded.
    updateInteractiveNodes(curr => curr.map(n => n.id === node.id ? makeFullyVisible(n) : n))
    // The pointer/geometry move trace samples getBoundingClientRect and builds
    // a wide row on every pointer move, forcing synchronous layout mid-drag.
    // That is a debugging instrument, not drag behavior: leaving it hot costs
    // frames on every drag, and a multi-node drag pays it per moved node.
    // Enable with `window.__axiomDragTrace = true` when investigating drags.
    if (!dragTraceEnabled()) {
      dragTraceRef.current = null
      return
    }
    const pointer = pointerTraceCoordinates(event)
    const viewport = getViewport()
    const flowPointer = screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY })
    const internal = getInternalNode(node.id)
    const absolute = internal?.internals.positionAbsolute ?? node.position
    const domRect = renderedNodeRect(node.id)
    const session = ++dragTraceSessionRef.current
    dragTraceRef.current = {
      session,
      nodeId: node.id,
      startedAt: performance.now(),
      lastLiveLogAt: 0,
      startClientX: pointer.clientX,
      startClientY: pointer.clientY,
      previousClientX: pointer.clientX,
      previousClientY: pointer.clientY,
      startFlowX: flowPointer.x,
      startFlowY: flowPointer.y,
      startNodeX: node.position.x,
      startNodeY: node.position.y,
      startAbsoluteX: absolute.x,
      startAbsoluteY: absolute.y,
      startDomLeft: domRect?.left ?? null,
      startDomTop: domRect?.top ?? null,
      previousNodeX: node.position.x,
      previousNodeY: node.position.y,
      previousChangeByNodeId: new Map([[node.id, { x: node.position.x, y: node.position.y }]]),
      callbackRows: [],
      changeRows: [],
    }
    const traceState = useSheetStore.getState()
    console.info(`[AxiomMoveTrace #${session}] start`, {
      id: node.id,
      type: node.type,
      callbackPosition: node.position,
      absolutePosition: absolute,
      parentId: node.parentId ?? null,
      viewport,
      pointerClientCssPixels: { x: pointer.clientX, y: pointer.clientY },
      pointerFlowUnits: flowPointer,
      devicePixelRatio: window.devicePixelRatio,
      conversion: `1 browser CSS px = ${1 / viewport.zoom} React Flow units at ${viewport.zoom}x zoom`,
      units: {
        clientAndDom: 'browser CSS pixels',
        nodeAndFlow: 'React Flow world units',
        screenEquivalent: 'React Flow delta multiplied by zoom (browser CSS pixels)',
        devicePixelEstimate: 'browser CSS pixels multiplied by devicePixelRatio',
      },
      activeSheetId: traceState.activeSheetId,
      planned: node.id.startsWith('planned:')
        ? traceState.planned.find(p => p.id === node.id.slice(8))
        : undefined,
      element: traceState.elements.find(e => (e.systemId ?? e.fileId ?? e.infraId) === node.id),
    })
  }, [applySelection, getInternalNode, getViewport, screenToFlowPosition, setSelectedNode, updateInteractiveNodes])

  const onNodeDrag: OnNodeDrag = useCallback((event, node) => {
    // Dragging a file out of the bin crosses a window boundary. The window
    // clips its own contents, so the real node vanishes the moment it leaves -
    // a ghost carries the gesture the rest of the way, at document level,
    // where nothing can clip it.
    // A drag that crosses between the Floor and the bin is one gesture over two
    // canvases, and whichever surface it is leaving clips or covers it. A ghost
    // carries the node the rest of the way, portalled to the document where
    // nothing can clip or stack above it.
    const crossPoint = pointerOf(event)
    const crossing = binMode
      // Leaving the bin window, which clips its own contents.
      ? !!crossPoint && !rectContains(document.querySelector('[data-bin-window]'), crossPoint)
      // Entering a bin, which is portalled above the Floor and so covers it.
      : pointOverBinTarget(crossPoint)

    if (crossing !== binCrossingRef.current) {
      binCrossingRef.current = crossing
      if (!binMode) {
        // Over a bin the canvas must hold still: the bin sits in the corner,
        // which is exactly where edge auto-pan would scroll the target out from
        // under the cursor aiming at it.
        reactFlowStore.setState({ autoPanOnNodeDrag: !crossing })
      }
    }
    if (!crossing || !crossPoint) {
      hideBinGhost()
    } else {
      const dragged = rfNodesRef.current.find(item => item.id === node.id)
      if (dragged) {
        showBinGhost({ node: dragged, scale: currentZoomRef.current })
        hideRealNode(node.id)
        // Position never enters React state, so following the cursor costs no
        // renders and cannot disturb the gesture React Flow is tracking.
        moveBinGhost(
          crossPoint.x,
          crossPoint.y,
          binMode ? !!systemAtFloorPoint(crossPoint.x, crossPoint.y) : true,
        )
      }
    }
    if (binMode) return
    if (resizingNodeIdRef.current === node.id) return
    const pointer = pointerTraceCoordinates(event)
    const clientX = pointer.clientX
    const clientY = pointer.clientY

    const moveTrace = dragTraceRef.current
    if (moveTrace?.nodeId === node.id) {
      const now = performance.now()
      const viewport = getViewport()
      const flowPointer = screenToFlowPosition({ x: clientX, y: clientY })
      const internal = getInternalNode(node.id)
      const absolute = internal?.internals.positionAbsolute ?? node.position
      const domRect = renderedNodeRect(node.id)
      const pointerStepX = clientX - moveTrace.previousClientX
      const pointerStepY = clientY - moveTrace.previousClientY
      const pointerTotalX = clientX - moveTrace.startClientX
      const pointerTotalY = clientY - moveTrace.startClientY
      const nodeStepX = node.position.x - moveTrace.previousNodeX
      const nodeStepY = node.position.y - moveTrace.previousNodeY
      const nodeTotalX = node.position.x - moveTrace.startNodeX
      const nodeTotalY = node.position.y - moveTrace.startNodeY
      const expectedFlowTotalX = pointerTotalX / viewport.zoom
      const expectedFlowTotalY = pointerTotalY / viewport.zoom
      const trackingErrorFlowX = nodeTotalX - expectedFlowTotalX
      const trackingErrorFlowY = nodeTotalY - expectedFlowTotalY
      const row: MoveTraceRow = {
        sample: moveTrace.callbackRows.length + 1,
        tMs: now - moveTrace.startedAt,
        zoom: viewport.zoom,
        viewportX: viewport.x,
        viewportY: viewport.y,
        pointerType: pointer.pointerType,
        clientX,
        clientY,
        pointerStepCssX: pointerStepX,
        pointerStepCssY: pointerStepY,
        pointerTotalCssX: pointerTotalX,
        pointerTotalCssY: pointerTotalY,
        pointerStepDeviceEstimateX: pointerStepX * window.devicePixelRatio,
        pointerStepDeviceEstimateY: pointerStepY * window.devicePixelRatio,
        eventMovementX: pointer.movementX,
        eventMovementY: pointer.movementY,
        coalescedEvents: pointer.coalescedEvents,
        expectedFlowStepX: pointerStepX / viewport.zoom,
        expectedFlowStepY: pointerStepY / viewport.zoom,
        cursorFlowX: flowPointer.x,
        cursorFlowY: flowPointer.y,
        cursorFlowTotalX: flowPointer.x - moveTrace.startFlowX,
        cursorFlowTotalY: flowPointer.y - moveTrace.startFlowY,
        nodeLocalX: node.position.x,
        nodeLocalY: node.position.y,
        nodeStepFlowX: nodeStepX,
        nodeStepFlowY: nodeStepY,
        nodeTotalFlowX: nodeTotalX,
        nodeTotalFlowY: nodeTotalY,
        nodeStepScreenX: nodeStepX * viewport.zoom,
        nodeStepScreenY: nodeStepY * viewport.zoom,
        expectedNodeX: moveTrace.startNodeX + expectedFlowTotalX,
        expectedNodeY: moveTrace.startNodeY + expectedFlowTotalY,
        trackingErrorFlowX,
        trackingErrorFlowY,
        trackingErrorScreenX: trackingErrorFlowX * viewport.zoom,
        trackingErrorScreenY: trackingErrorFlowY * viewport.zoom,
        nodeAbsoluteX: absolute.x,
        nodeAbsoluteY: absolute.y,
        absoluteTotalFlowX: absolute.x - moveTrace.startAbsoluteX,
        absoluteTotalFlowY: absolute.y - moveTrace.startAbsoluteY,
        domLeft: domRect?.left ?? null,
        domTop: domRect?.top ?? null,
        domTotalCssX: domRect && moveTrace.startDomLeft !== null ? domRect.left - moveTrace.startDomLeft : null,
        domTotalCssY: domRect && moveTrace.startDomTop !== null ? domRect.top - moveTrace.startDomTop : null,
      }
      moveTrace.callbackRows.push(row)
      moveTrace.previousClientX = clientX
      moveTrace.previousClientY = clientY
      moveTrace.previousNodeX = node.position.x
      moveTrace.previousNodeY = node.position.y
      if (now - moveTrace.lastLiveLogAt >= 250) {
        moveTrace.lastLiveLogAt = now
        console.debug(`[AxiomMoveTrace #${moveTrace.session}] live sample ${row.sample}`, row)
      }
    }

    // Freeform hit-testing: the CURSOR chooses which frame you are dropping
    // into - that is the gesture the hand is making, and requiring the whole
    // node to be inside made frames nearly impossible to hit. Containment is
    // enforced separately, at commit, by nudging the node fully inside the
    // frame it landed in. No barriers, cell snapping, sibling displacement,
    // or DOM nudges.
    dragPositionRef.current.set(node.id, { x: node.position.x, y: node.position.y })
    const currentInternal = getInternalNode(node.id)
    if (currentInternal) {
      dragAbsolutePositionsRef.current.set(node.id, {
        x: currentInternal.internals.positionAbsolute.x,
        y: currentInternal.internals.positionAbsolute.y,
      })
    }
    const cursor = screenToFlowPosition({ x: clientX, y: clientY })
    const allNodes = displayNodesRef.current
    const parentById = new Map(allNodes.map(candidate => [candidate.id, candidate.parentId ?? null]))
    const selectedDuringDrag = new Set(allNodes.filter(candidate => candidate.selected).map(candidate => candidate.id))
    selectedDuringDrag.add(node.id)
    const isInsideDraggedSubtree = (candidateId: string) => {
      let current: string | null = candidateId
      const visited = new Set<string>()
      while (current && !visited.has(current)) {
        if (selectedDuringDrag.has(current)) return true
        visited.add(current)
        current = parentById.get(current) ?? null
      }
      return false
    }
    const candidates = allNodes.filter(candidate => {
      if (candidate.id === node.id || isInsideDraggedSubtree(candidate.id) || candidate.type !== 'system') return false
      if (reviewMode && files.some(file => file.id === node.id) &&
          !reviewEditableNodeIds?.has(candidate.id)) return false
      // A live system IS a valid drop target on a sheet: nesting a planned
      // class into an existing system is the whole point of proposing one.
      // This used to exclude anything the sheet had no opinion about, which
      // made sense while the Floor was dimmed and inert beneath a sheet. The
      // Floor is fully interactive now, so the exclusion only blocked nesting.
      if (overlaySheetId && candidate.id.startsWith('planned:') &&
          !activeNodeIds.has(candidate.id)) return false
      const internal = getInternalNode(candidate.id)
      if (!internal) return false
      const absolute = internal.internals.positionAbsolute
      const width = Number(candidate.measured?.width ?? candidate.style?.width ?? 0)
      const height = Number(candidate.measured?.height ?? candidate.style?.height ?? 0)
      return cursor.x >= absolute.x && cursor.x <= absolute.x + width &&
        cursor.y >= absolute.y && cursor.y <= absolute.y + height
    }).sort((a, b) => {
      const area = (candidate: Node) => Number(candidate.measured?.width ?? candidate.style?.width ?? 0) * Number(candidate.measured?.height ?? candidate.style?.height ?? 0)
      return area(a) - area(b)
    })
    const previousTarget = dropTargetRef.current
    const nextTarget = candidates[0]?.id ?? null
    dropTargetRef.current = nextTarget
    if (previousTarget !== nextTarget) {
      updateInteractiveNodes(current => current.map(candidate => ({
        ...candidate,
        data: { ...candidate.data, isDropTarget: candidate.id === nextTarget },
      })))
    }
  }, [getInternalNode, getViewport, screenToFlowPosition, overlaySheetId, activeNodeIds, updateInteractiveNodes, reviewMode, reviewEditableNodeIds, files])

  const onNodeDragStop: OnNodeDrag = useCallback((event, node) => {
    if (resizingNodeIdRef.current === node.id) return
    const finalPosition = dragPositionRef.current.get(node.id) ?? node.position
    dragPositionRef.current.delete(node.id)
    const moveTrace = dragTraceRef.current
    if (moveTrace?.nodeId === node.id) {
      const viewport = getViewport()
      const stopPointer = pointerTraceCoordinates(event)
      const renderedPosition = displayNodesRef.current.find(n => n.id === node.id)?.position
      const nonZeroScreenSteps = moveTrace.callbackRows.flatMap(row => {
        const x = typeof row.nodeStepScreenX === 'number' ? Math.abs(row.nodeStepScreenX) : 0
        const y = typeof row.nodeStepScreenY === 'number' ? Math.abs(row.nodeStepScreenY) : 0
        return [x, y].filter(value => value > Number.EPSILON)
      })
      const nonZeroFlowSteps = moveTrace.callbackRows.flatMap(row => {
        const x = typeof row.nodeStepFlowX === 'number' ? Math.abs(row.nodeStepFlowX) : 0
        const y = typeof row.nodeStepFlowY === 'number' ? Math.abs(row.nodeStepFlowY) : 0
        return [x, y].filter(value => value > Number.EPSILON)
      })
      const summary = {
        id: node.id,
        parentId: node.parentId ?? null,
        elapsedMs: performance.now() - moveTrace.startedAt,
        zoomAtStop: viewport.zoom,
        browserCssPixelsPerFlowUnit: viewport.zoom,
        flowUnitsPerBrowserCssPixel: 1 / viewport.zoom,
        devicePixelRatio: window.devicePixelRatio,
        callbackSamples: moveTrace.callbackRows.length,
        reactFlowPositionChanges: moveTrace.changeRows.length,
        smallestObservedNodeStepFlowUnits: nonZeroFlowSteps.length ? Math.min(...nonZeroFlowSteps) : 0,
        smallestObservedNodeStepBrowserCssPixels: nonZeroScreenSteps.length ? Math.min(...nonZeroScreenSteps) : 0,
        startPointerCss: { x: moveTrace.startClientX, y: moveTrace.startClientY },
        stopPointerCss: { x: stopPointer.clientX, y: stopPointer.clientY },
        totalPointerCss: {
          x: stopPointer.clientX - moveTrace.startClientX,
          y: stopPointer.clientY - moveTrace.startClientY,
        },
        startNodeFlow: { x: moveTrace.startNodeX, y: moveTrace.startNodeY },
        callbackPosition: node.position,
        authoritativePosition: finalPosition,
        renderedPosition,
        totalNodeFlow: {
          x: finalPosition.x - moveTrace.startNodeX,
          y: finalPosition.y - moveTrace.startNodeY,
        },
        totalNodeScreenEquivalent: {
          x: (finalPosition.x - moveTrace.startNodeX) * viewport.zoom,
          y: (finalPosition.y - moveTrace.startNodeY) * viewport.zoom,
        },
      }
      console.groupCollapsed(`[AxiomMoveTrace #${moveTrace.session}] COMPLETE - ${node.id}`)
      console.info('Summary and unit conversion', summary)
      console.info('Drag callback samples - pointer input compared with node output')
      console.table(moveTrace.callbackRows)
      console.info('Raw onNodesChange position emissions from React Flow')
      console.table(moveTrace.changeRows)
      console.log('Copyable raw trace', {
        summary,
        callbackSamples: moveTrace.callbackRows,
        reactFlowPositionChanges: moveTrace.changeRows,
      })
      console.groupEnd()
      dragTraceRef.current = null
    }
    // Clear drag state - restore zoom visibility, clear drop highlight
    setIsDraggingScene(false)
    // Both bin gestures are resolved before any layout write, because a file
    // crossing between canvases must not also persist a position on the canvas
    // it just left.
    const pointer = pointerOf(event)
    if (binMode) {
      // The window listener normally got here first; this covers the gesture
      // that ended inside the bin, where React Flow's own drag does terminate.
      if (pointer) finishBinDrag(pointer.x, pointer.y, 'react-flow-dragstop')
      draggingNodeIdRef.current = null
      dropTargetRef.current = null
      return
    }
    // The window listener normally got here first; this covers a release the
    // Floor's own drag did terminate.
    if (!binMode && pointer && finishFloorBinDrag(pointer.x, pointer.y, 'react-flow-dragstop')) {
      draggingNodeIdRef.current = null
      dropTargetRef.current = null
      return
    }
    if (!binMode) {
      floorBinDragRef.current = null
      hideBinGhost()
    }
    draggingNodeIdRef.current = null
    const prevTarget = dropTargetRef.current
    dropTargetRef.current = null

    // Direct DOM cleanup of the React Flow node wrapper styles
    const el = document.querySelector(`.react-flow__node[data-id="${node.id}"]`) as HTMLElement | null
    if (el) {
      el.style.transition = ''
      el.style.marginLeft = ''
      el.style.marginTop = ''
    }
    // Floor drops are one atomic frame transform. They never rewrite semantic
    // system/file ownership.
    const sheetState = useSheetStore.getState()
    const sheetId = isolatedScene ? null : sheetState.activeSheetId
    const graph = useGraphStore.getState()
    const workspaceId = reviewScene?.workspaceId ?? (sheetId ? workspaceIdForOverlay : graph.currentProject?.id)
    const all = displayNodesRef.current
    const absolutePositions = new Map(all.map(candidate => [
      candidate.id,
      getInternalNode(candidate.id)?.internals.positionAbsolute ?? candidate.position,
    ]))
    // Position changes are the authoritative gesture output. They can be one
    // React render ahead of both displayNodesRef and XYFlow's internal store.
    for (const [id, position] of dragAbsolutePositionsRef.current) {
      absolutePositions.set(id, position)
    }
    // The stop callback owns the primary node's final local position. Derive
    // its absolute value explicitly so a final pointer move without a committed
    // onNodesChange sample cannot be lost.
    const dragged = all.find(candidate => candidate.id === node.id)
    const parentAbsolute = dragged?.parentId
      ? absolutePositions.get(dragged.parentId) ?? { x: 0, y: 0 }
      : { x: 0, y: 0 }
    absolutePositions.set(node.id, {
      x: parentAbsolute.x + finalPosition.x,
      y: parentAbsolute.y + finalPosition.y,
    })
    dragAbsolutePositionsRef.current.clear()

    // This is the only drop engine. A Sheet changes the writable layout layer
    // and selection boundary; geometry, collision, packing, containment,
    // size parity, and compression are the live Canvas implementation.
    const plan = planCanvasDrop({
      workspaceId: workspaceId ?? null,
      draggedNodeId: node.id,
      targetNodeId: prevTarget,
      allNodes: all,
      absolutePositions,
      systemIds: sheetId
        ? sheetSystemIds
        : new Set(systems.map(system => system.id)),
      fileIds: sheetId
        ? sheetFileIds
        : new Set(files.map(file => file.id)),
      infraIds: sheetId
        ? sheetInfraIds
        : new Set(infraNodes.map(infra => infra.id)),
      floorLayouts: reviewScene ? floorLayouts : sheetId ? sheetEffectiveLayouts : graph.floorLayouts,
      editableNodeIds: reviewEditableNodeIds ?? (sheetId ? activeNodeIds : undefined),
    })

    if (workspaceId && plan.updates.length > 0) {
      setIsTransitioningLayout(false)
      if (reviewMode && previewReviewLayouts && saveReviewLayouts) {
        const withoutPersistenceFields = (layouts: FloorLayout[]) => layouts.map(({
          workspaceId: _workspaceId,
          updatedAt: _updatedAt,
          ...layout
        }) => layout)
        previewReviewLayouts(withoutPersistenceFields(plan.arrivalLayouts))
        requestAnimationFrame(() => {
          setIsTransitioningLayout(true)
          requestAnimationFrame(() => {
            void saveReviewLayouts(plan.updates).catch(error => {
              console.error('[AxiomCanvas] proposal group drop failed', error)
            })
            window.setTimeout(() => setIsTransitioningLayout(false), LAYOUT_TRANSITION_MS)
          })
        })
      } else if (sheetId) {
        const rollbackLayouts = sheetState.layouts
        const arrivalMutations = plan.arrivalLayouts.map(({
          workspaceId: _workspaceId,
          updatedAt: _updatedAt,
          ...layout
        }) => layout)
        sheetState.previewLayoutsBatch(workspaceId, sheetId, arrivalMutations)
        // The transient XYFlow interaction snapshot has completed its one job.
        // Keeping it alive masks the optimistic canonical layouts and made
        // nodes jump back as soon as selection changed.
        setSheetInteractionNodes(null)
        requestAnimationFrame(() => {
          setIsTransitioningLayout(true)
          requestAnimationFrame(() => {
            void sheetState.updateLayoutsBatch(
              workspaceId,
              sheetId,
              plan.updates,
              rollbackLayouts,
            ).catch(() => {})
            window.setTimeout(() => setIsTransitioningLayout(false), LAYOUT_TRANSITION_MS)
          })
        })
      } else {
        useGraphStore.setState(state => ({
          floorLayouts: replaceFloorLayouts(state.floorLayouts, plan.arrivalLayouts, plan.changedKeys),
        }))
        requestAnimationFrame(() => {
          setIsTransitioningLayout(true)
          requestAnimationFrame(() => {
            useGraphStore.setState(state => ({
              floorLayouts: replaceFloorLayouts(state.floorLayouts, plan.optimisticLayouts, plan.changedKeys),
            }))
            window.setTimeout(() => setIsTransitioningLayout(false), LAYOUT_TRANSITION_MS)
            void apiSaveFloorLayouts(workspaceId, plan.updates).catch(error => {
              console.error('[AxiomCanvas] floor group drop failed', error)
              useGraphStore.setState(state => ({
                floorLayouts: replaceFloorLayouts(state.floorLayouts, plan.previousLayouts, plan.changedKeys),
              }))
            })
          })
        })
      }
    }

    // A drop the layer refused to plan (a sheet node the sheet cannot move) has
    // no group of its own, and must not be read as "the user selected nothing".
    if (plan.selectedIds.length > 0) commitSelection(new Set(plan.selectedIds))
    sceneSourceRef.current = `${sheetId ? 'sheet' : 'floor'}-drop${plan.updates.length > 1 ? '-repack' : ''}`
    if (sheetId) {
      // Selection is projected from selectedIdsRef/selectionRevision. Do not
      // recreate a stale sheetInteractionNodes snapshot merely to clear flags.
      setSheetInteractionNodes(null)
    } else {
      updateInteractiveNodes(current => current.map(candidate => ({
        ...candidate,
        selected: plan.selectedIds.length > 0
          ? plan.selectedIds.includes(candidate.id)
          : candidate.selected,
        data: { ...candidate.data, isDropTarget: false, snapPreview: null, previewOffset: null },
      })))
    }

  }, [currentProject, getInternalNode, getViewport, screenToFlowPosition, overlaySheetId, activeElementByNodeId, activePlannedByNodeId, activeNodeIds, workspaceIdForOverlay, updateInteractiveNodes, sheetSystemIds, sheetFileIds, sheetInfraIds, sheetEffectiveLayouts, reviewMode, reviewScene?.workspaceId, reviewEditableNodeIds, previewReviewLayouts, saveReviewLayouts, systems, files, infraNodes, floorLayouts])

  const renderedNodes = useMemo(() => {
    if (!overlaySheetId) return attentionNodes
    return attentionNodes.map(n => {
      if (!activeNodeIds.has(n.id)) return n
      const handlers = readOnly ? undefined : getResizeHandlers(n.id, true)
      if (n.data.onResizeStart === handlers?.onResizeStart && n.data.onResizeEnd === handlers?.onResizeEnd) {
        return n
      }
      return {
        ...n,
        data: {
          ...n.data,
          onResizeStart: handlers?.onResizeStart,
          onResizeEnd: handlers?.onResizeEnd,
        },
      }
    })
  }, [attentionNodes, overlaySheetId, activeNodeIds, readOnly, getResizeHandlers])

  // Identity of renderedNodes churns every render while a sheet overlay is
  // open, so the recovery below keys off this value-stable signature instead.
  const renderedSceneSignature = useMemo(
    () => `${sceneProjectId}:${renderedNodes.map(node => node.id).sort().join('|')}`,
    [renderedNodes, sceneProjectId],
  )
  const renderedNodesRef = useRef(renderedNodes)
  renderedNodesRef.current = renderedNodes

  // Scene-mutation tracer. Diffs what is actually about to be painted, so a
  // frame where geometry jumps is attributed to the path that caused it.
  useEffect(() => {
    const next = sceneGeometry(renderedNodes)
    const delta = diffScene(sceneSnapshotRef.current, next)
    sceneSnapshotRef.current = next
    if (sceneDeltaIsQuiet(delta)) return
    recordSceneMutation({
      ...delta,
      at: Math.round(performance.now()),
      source: sceneSourceRef.current,
      zoom: currentZoomRef.current,
      nodeCount: next.length,
      dragging: draggingNodeIdRef.current,
    })
  }, [renderedNodes])

  useEffect(() => {
    if (canonicalNodeCount === 0 || renderedNodesRef.current.length === 0) return
    const signature = renderedSceneSignature
    const timer = window.setTimeout(() => {
      const root = canvasRootRef.current
      if (!root) return
      const domNodes = [...root.querySelectorAll<HTMLElement>('.react-flow__node')]
      const visibleDomNodeCount = domNodes.filter(node => {
        const style = window.getComputedStyle(node)
        return style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number(style.opacity) > 0.1
      }).length
      if (visibleDomNodeCount > 0) {
        domSceneRecoveryRef.current = ''
        return
      }
      if (domSceneRecoveryRef.current === signature) return
      domSceneRecoveryRef.current = signature
      console.error('[scene-integrity] React Flow DOM diverged from controlled scene', {
        projectId: sceneProjectId,
        canonicalNodeCount,
        candidateNodeCount: candidateRfNodes.length,
        renderedNodeCount: renderedNodesRef.current.length,
        domNodeCount: domNodes.length,
        visibleDomNodeCount,
        candidateIntegrity: candidateSceneIntegrity,
      })
      // Re-issue fresh node objects once. This re-synchronizes React Flow's
      // internal lookup with the still-valid controlled projection.
      sceneSourceRef.current = 'dom-recovery'
      setRfNodes(current => current.map(node => ({ ...node })))
    }, 80)
    return () => window.clearTimeout(timer)
  }, [
    candidateSceneIntegrity,
    canonicalNodeCount,
    renderedSceneSignature,
    sceneProjectId,
  ])

  const traceSuspiciousCursor = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const element = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
    if (!element) return
    const cursor = window.getComputedStyle(element).cursor
    if (!['crosshair', 'cell', 'copy', 'alias'].includes(cursor)) return
    const ancestry: string[] = []
    let current: HTMLElement | null = element
    for (let depth = 0; current && depth < 7; depth++, current = current.parentElement) {
      ancestry.push([
        current.tagName.toLowerCase(),
        current.id ? `#${current.id}` : '',
        ...[...current.classList].map(name => `.${name}`),
        current.dataset.id ? `[data-id=${current.dataset.id}]` : '',
      ].join(''))
    }
    const signature = `${cursor}|${ancestry.join('>')}|${selectionMode}|${overlaySheetId ?? 'floor'}`
    if (cursorTraceSignatureRef.current === signature) return
    cursorTraceSignatureRef.current = signature
    console.warn('[AxiomCursorTrace]', {
      cursor,
      element: ancestry[0],
      ancestry,
      selectionMode,
      sheetId: overlaySheetId,
      readOnly,
      nodeConnectionsEnabled: !readOnly && !!overlaySheetId,
    })
  }, [selectionMode, overlaySheetId, readOnly])

  const traceCanvasHit = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.altKey) return
    const point = { x: event.clientX, y: event.clientY }
    const stack = document.elementsFromPoint(point.x, point.y).slice(0, 12).map(element => {
      const html = element as HTMLElement
      return {
        tag: html.tagName.toLowerCase(),
        id: html.id || null,
        className: typeof html.className === 'string' ? html.className : null,
        dataId: html.dataset?.id ?? null,
        resizeDirection: html.dataset?.resizeDirection ?? null,
        pointerEvents: getComputedStyle(html).pointerEvents,
      }
    })
    const claimingNodes = [...(canvasRootRef.current?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])]
      .filter(element => {
        const rect = element.getBoundingClientRect()
        return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
      })
      .map(element => {
        const id = element.dataset.id ?? ''
        const rect = element.getBoundingClientRect()
        const node = displayNodesRef.current.find(candidate => candidate.id === id)
        const resizer = [...(canvasRootRef.current?.querySelectorAll<HTMLElement>('.axiom-node-resizer') ?? [])]
          .find(candidate => candidate.dataset.nodeId === id) ?? null
        const handles = resizer ? [...resizer.querySelectorAll<HTMLElement>('.axiom-floating-resize-handle')] : []
        return {
          id,
          selected: element.classList.contains('selected'),
          rectX: rect.x,
          rectY: rect.y,
          rectWidth: rect.width,
          rectHeight: rect.height,
          pointerEvents: getComputedStyle(element).pointerEvents,
          inlineStyle: element.getAttribute('style'),
          modelWidth: node?.width ?? null,
          modelHeight: node?.height ?? null,
          modelStyleWidth: node?.style?.width ?? null,
          modelStyleHeight: node?.style?.height ?? null,
          resizerRect: resizer ? (() => {
            const value = resizer.getBoundingClientRect()
            return { x: value.x, y: value.y, width: value.width, height: value.height }
          })() : null,
          handleRects: handles.map(handle => {
            const value = handle.getBoundingClientRect()
            return { direction: handle.dataset.resizeDirection, x: value.x, y: value.y, width: value.width, height: value.height }
          }),
        }
      })
    const payload = {
      point,
      viewport: getViewport(),
      target: stack[0] ?? null,
      elementStack: stack,
      claimingNodes,
    }
    const flatNodes = claimingNodes.map(node => {
      const handles = node.handleRects.map(handle =>
        `${handle.direction}:${handle.width.toFixed(1)}x${handle.height.toFixed(1)}`).join(',') || 'none'
      return `${node.id}[selected=${node.selected},rect=${node.rectWidth.toFixed(1)}x${node.rectHeight.toFixed(1)},handles=${handles}]`
    }).join(' | ') || 'none'
    console.warn(
      `[AxiomHitTraceSummary] point=${point.x},${point.y} zoom=${payload.viewport.zoom} ` +
      `target=${payload.target?.className ?? payload.target?.tag ?? 'none'} claiming=${flatNodes}`,
    )
    console.warn('[AxiomHitTrace]', payload)
    window.setTimeout(() => {
      const selected = [...(canvasRootRef.current?.querySelectorAll<HTMLElement>('.react-flow__node.selected') ?? [])]
        .map(element => {
          const rect = element.getBoundingClientRect()
          const resizer = [...(canvasRootRef.current?.querySelectorAll<HTMLElement>('.axiom-node-resizer') ?? [])]
            .find(candidate => candidate.dataset.nodeId === element.dataset.id)
          const firstHandle = resizer?.querySelector<HTMLElement>('.axiom-floating-resize-handle') ?? null
          const firstVisual = firstHandle?.firstElementChild as HTMLElement | null
          const hitRect = firstHandle?.getBoundingClientRect()
          const visualRect = firstVisual?.getBoundingClientRect()
          return `${element.dataset.id}[node=${rect.width.toFixed(1)}x${rect.height.toFixed(1)},` +
            `hit=${hitRect ? `${hitRect.width.toFixed(1)}x${hitRect.height.toFixed(1)}` : 'none'},` +
            `visual=${visualRect ? `${visualRect.width.toFixed(1)}x${visualRect.height.toFixed(1)}` : 'none'}]`
        })
      console.warn(`[AxiomPostClickSummary] selected=${selected.join(' | ') || 'none'}`)
    }, 100)
  }, [getViewport])

  return (
    <div
      ref={canvasRootRef}
      {...{ [CANVAS_SCOPE_ATTR]: '' }}
      className={[
        reviewMode ? 'axiom-canvas-review' : '',
        reviewMode && reviewLayoutReady ? 'axiom-canvas-review-ready' : '',
        isTransitioningLayout ? 'layout-transition' : '',
        isDraggingScene ? 'axiom-dragging' : '',
        // Sheet mode is signalled by the SURFACE, not by degrading the nodes.
        // The architecture stays at full fidelity because a sheet is where you
        // work on it; the environment is what tells you edits are a proposal.
        // Driven by phase, not by the raw id, so leaving animates too.
        sheetPhase.phase ? 'axiom-sheet-mode' : '',
      ].filter(Boolean).join(' ') || undefined}
      data-sheet-phase={sheetPhase.phase ?? undefined}
      onDragOverCapture={onOverlayDragOver}
      onDropCapture={onOverlayDrop}
      onPointerDownCapture={traceCanvasHit}
      onPointerMoveCapture={traceSuspiciousCursor}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      <ReactFlow
        zoomOnScroll={false}
        nodes={renderedNodes}
        edges={displayEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        defaultEdgeOptions={{ type: 'orthogonal' }}
        onNodesChange={readOnly ? undefined : onNodesChange}
        onEdgesChange={readOnly ? undefined : onEdgesChange}
        onConnect={readOnly || !overlaySheetId ? undefined : onConnectPlanned}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        onSelectionDragStart={readOnly ? undefined : () => setIsDraggingScene(true)}
        onSelectionDragStop={readOnly ? undefined : () => setIsDraggingScene(false)}
        onNodeDragStart={readOnly ? undefined : onNodeDragStart}
        onNodeDrag={readOnly ? undefined : onNodeDrag}
        onNodeDragStop={readOnly ? undefined : onNodeDragStop}
        onMove={onMove}
        minZoom={MIN_CANVAS_ZOOM}
        maxZoom={MAX_CANVAS_ZOOM}
        defaultViewport={{ x: 0, y: 0, zoom: 0.5 }}
        fitViewOptions={{ padding: 0.14, maxZoom: 1.0 }}
        proOptions={{ hideAttribution: true }}
        panOnDrag={selectionMode ? [1, 2] : true}
        selectionOnDrag={readOnly ? false : selectionMode}
        selectionMode={selectionMode ? SelectionMode.Partial : SelectionMode.Full}
        // Must match what the click handler treats as "add to my selection", or
        // React Flow collapses the selection on the same click Axiom extends it
        // on, and the highlight disagrees with what the next drag picks up.
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly && !!overlaySheetId}
        deleteKeyCode={null}
        elementsSelectable={!readOnly}
        snapToGrid={false}
        // Large graphs: skip rendering off-screen nodes. Kept off for small
        // graphs where the per-move visibility recompute isn't worth it.
        onlyRenderVisibleElements={rfNodes.length > VIEWPORT_CULLING_NODE_COUNT}
      >
        {/* Pattern color transparent - the drafting line grid is painted by
            .react-flow__background CSS; this component just provides the element. */}
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="transparent" />
        <Controls className="axiom-canvas-controls" showInteractive={false} />
        <MiniMap
          className="axiom-canvas-minimap"
          position="top-right"
          // Top-right, leaving the bottom-right corner to the bins. They are
          // drop targets and the minimap is not, so the corner belongs to the
          // thing you have to be able to throw something at.
          style={{ width: 160, height: 100 }}
          nodeColor={(n) => {
            const d = n.data as unknown as SystemNodeData | FileNodeData | InfraNodeData
            if ('color' in d && d.color) return d.color
            if (n.type === 'file') return '#6C757D'
            if (n.type === 'infra') return '#D4A843'
            return '#2a2e33'
          }}
          maskColor="rgba(49,62,58,0.38)"
        />
        <LivingFlowOverlay
          events={relationshipFx}
          nodes={livingDisplayNodes}
          visibilityOptions={livingVisibilityOptions}
        />
        {deferCanvasMaterialization && (
          <Panel position="top-center" className="axiom-canvas-materializing">
            <div role="status" aria-live="polite">
              <span aria-hidden="true" />
              <div>
                <strong>Organizing {files.length.toLocaleString()} files</strong>
                <small>Building stable architecture before drawing the Floor</small>
              </div>
            </div>
          </Panel>
        )}
        <Panel position="top-left" className="axiom-canvas-toolbar">
          <button
            type="button"
            onClick={tidyFrame}
            disabled={isTidying || readOnly}
            aria-busy={isTidying}
            className="axiom-canvas-command"
          >
            {isTidying ? (
              <>
                <svg
                  style={{ animation: 'spin 1s linear infinite', width: '14px', height: '14px' }}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <circle cx="12" cy="12" r="10" stroke="rgba(49, 94, 88, 0.24)" />
                  <path d="M12 2a10 10 0 0 1 10 10" />
                </svg>
                Tidying...
              </>
            ) : (
              <>
                <svg
                  style={{ width: '14px', height: '14px' }}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                  <line x1="12" y1="22.08" x2="12" y2="12" />
                </svg>
                Tidy Layout
              </>
            )}
          </button>
          {focusFileIds.size > 0 && (
            <button
              type="button"
              onClick={() => setFocusEnabled(v => !v)}
              title="Dim nodes that are off the active trace / runtime path"
              className={focusEnabled
                ? 'axiom-canvas-command axiom-canvas-command--trace-active'
                : 'axiom-canvas-command'}
            >
              <svg style={{ width: '14px', height: '14px' }} viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 5V3M12 21v-2M5 12H3M21 12h-2" />
              </svg>
              Focus{focusEnabled ? ' On' : ' Off'}
            </button>
          )}
        </Panel>
        {/* The bin canvas must not grow its own bins. Gated on mount rather
            than hidden in CSS, so the inner canvas never subscribes to a
            bin it is itself the inside of. */}
        {!binMode && (
          <Panel position="bottom-right" className="axiom-canvas-bins-panel">
            <CanvasBins
              documents={bins.documents}
              unclassified={binsHoldUnclassified ? bins.unclassified : []}
              documentsOpen={documentsOpen}
              onToggleDocuments={() => {
                const store = useGraphStore.getState()
                store.setDocumentsOpen(!store.documentsOpen)
              }}
              dragActive={isDraggingScene}
              readOnly={readOnly}
            />
          </Panel>
        )}
        <Panel position="bottom-left" className="axiom-canvas-zoom-panel">
          <ZoomIndicator />
        </Panel>
      </ReactFlow>

      {!reviewMode && selectedFileIds.length > 1 && (
        <div className="axiom-selection-actions">
          <span className="axiom-selection-actions__summary">
            <strong>{selectedFileIds.length}</strong>
            <span>files selected</span>
          </span>
          <button
            type="button"
            onClick={() => setGroupDialogOpen(true)}
            className="axiom-selection-action axiom-selection-action--primary"
          >
            Group into System
          </button>
          <button
            type="button"
            onClick={() => setSheetDialogOpen(true)}
            title="Curate the selection onto a named sheet - a live diagram telling one story"
            className="axiom-selection-action"
          >
            New Sheet
          </button>
          <button
            type="button"
            onClick={() => setSelectionMode(false)}
            className="axiom-selection-action axiom-selection-action--ghost"
          >
            Cancel
          </button>
        </div>
      )}

      {!reviewMode && <GroupDialog
        isOpen={groupDialogOpen}
        onClose={() => setGroupDialogOpen(false)}
        selectedFileIds={selectedFileIds}
        onSuccess={() => {
          setRfNodes(nodes => nodes.map(n => ({ ...n, selected: false })))
          commitSelection(emptySelection())
          useGraphStore.getState().setSelectionMode(false)
        }}
      />}

      {/* Sheet layer active: stencil palette + slim indicator */}
      {overlaySheetId && (
        <>
          <SheetPalette />
          <div className="axiom-sheet-layer-indicator">
            <span aria-hidden="true" />
            Sheet Layer Active
          </div>
        </>
      )}

      {!reviewMode && <NewSheetDialog
        isOpen={sheetDialogOpen}
        onClose={() => setSheetDialogOpen(false)}
        selectedFileIds={selectedFileIds}
        onSuccess={() => {
          setRfNodes(nodes => nodes.map(n => ({ ...n, selected: false })))
          commitSelection(emptySelection())
          useGraphStore.getState().setSelectionMode(false)
        }}
      />}

      {infraPickerNodeId && activePlannedByNodeId.get(`planned:${infraPickerNodeId}`) && (
        <InfraPickerDialog
          mode="assign"
          node={activePlannedByNodeId.get(`planned:${infraPickerNodeId}`)!}
          onClose={() => setInfraPickerNode(null)}
        />
      )}

    </div>
  )
}
