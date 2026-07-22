/**
 * AxiomCanvas — Infinity-zoom codebase graph.
 *
 * Everything is a node. Zoom controls opacity only — layout never rebuilds on zoom.
 *
 * Sizing philosophy:
 *   - Leaf systems: fixed size by depth (LEAF_W/H)
 *   - Container systems: recursive bottom-up — sized to fit their actual children
 *   - Top-level: grid of depth-0 nodes with collision resolution
 *   Every level uses cols = ceil(sqrt(N)) for a square grid.
 *   Sizes cascade bottom-up: containers fit their children exactly.
 *
 * Zoom thresholds:
 *   Dynamically computed from actual layout sizes after each layout pass.
 *   threshold[d] = TARGET_SCREEN_PX / smallestNodeWidth[d-1]
 *   This means children appear when the smallest parent at that depth fills
 *   ~400px of viewport — a "late reveal" Google Maps feel.
 *   Transitions use continuous fade (opacity + scale + blur) over a 30% range.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
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
  MarkerType,
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
import { GroupDialog } from '../components/GroupDialog'
import { NewSheetDialog } from '../components/NewSheetDialog'
import { SheetPalette, type StencilDef } from '../components/SheetPalette'
import { InfraPickerDialog } from '../components/InfraPickerDialog'
import { plannedMembers, plannedMetadata, sheetElementMetadata, useSheetStore } from '../store/sheetStore'
import type { PlannedNodeKind, PlannedNodeMetadata, SheetLayoutMutation } from '../store/sheetStore'
import { filenameForLanguage, languageFromFilename } from './languages'
import { apiUpdateSystem, apiSaveNodePosition, apiSaveFloorLayouts } from './arcdApi'
import { boundsOf, contentRect, findUnscaledIncomingPlacement, fitReferenceFrame, FRAME_CONTENT_PADDING, FRAME_HEADER_HEIGHT, frameHeaderAllowance, highestSelectedRoots, localScaleAfterWorldFit, normalizeGeometry, transformReferencePoint } from './frameGeometry'
import { countDirectChildren } from './directChildCounts'
import { packFrame, placeIncoming } from './packing'
import { childPositionAfterParentResize, minimumContainerSize, resizeChanged, toCanonicalResizeGeometry, type NodeResizeParams } from './resizeGeometry'

// ─── Node type registry ────────────────────────────────────────────────────

const NODE_TYPES: NodeTypes = {
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

// ─── Zoom thresholds ───────────────────────────────────────────────────────
// Reveal is size-driven, not depth-driven. A node opens its contents once the
// node itself is rendered large enough on screen, so arbitrarily sized and
// scaled frames each get their own reveal point. Children are always
// physically smaller than their parent, so reveal cascades outward-in.
// This one constant tunes the entire progression: the on-screen size
// (geometric mean of rendered width and height, in pixels) at which a node
// reveals what it contains.
const REVEAL_CONTAINER_PX = 480
const MIN_CANVAS_ZOOM = 0.02
const MAX_CANVAS_ZOOM = 100

// ─── World-space sizing ────────────────────────────────────────────────────
// One scale factor halves the cell size per depth level.
// One gap value drives everything: gap = floor(cellH / 2).
// Container formula (same for width and height):
//   width  = n_cols * cw + (n_cols + 1) * gap
//   height = n_rows * ch + (n_rows + 1) * gap
// The header area equals one gap, so the formula is symmetric in all directions.

const BASE_FILE_W = 220   // cell width inside a depth-0 system
const BASE_FILE_H = 110   // cell height inside a depth-0 system
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

// ─── Color palette ─────────────────────────────────────────────────────────

// Muted technical accents, one per nesting depth — matches --depth-0..3 in global.css
const PALETTE = ['#5B8A9A','#C4956A','#7A9E7E','#A07B8A']

function systemColor(depth: number): string {
  return PALETTE[depth % PALETTE.length]
}

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${r}, ${g}, ${b}`
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

    // Empty system — minimum single-cell placeholder
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
      const gap = gridGap(d)
      const packed = packFrame(
        items.map(item => ({ id: item.id, width: item.w, height: item.h })),
        { baseGap: gap },
      )
      for (const item of items) {
        const position = packed.positions.get(item.id)!
        computedPositions.set(item.id, { x: gap + position.x, y: gap + position.y, w: item.w, h: item.h })
        if (item.type === 'system') computedSizes.set(item.id, { w: item.w, h: item.h })
      }
      computedSizes.set(systemId, { w: packed.width + gap * 2, h: packed.height + gap * 2 })
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
  agentTouched: boolean
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
  agentTouched: boolean
  depth: number
  currentZoom: number
  childrenVisible: number
  worldScale: number  // fileNodeSize(parentDepth).w / BASE_FILE_W — drives proportional font/padding
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
  agentTouched: boolean
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

// ─── Zoom visibility (continuous fade) ─────────────────────────────────────
// A node's contents flip visible once the node is rendered large enough on
// screen (REVEAL_CONTAINER_PX). CSS completes the fade after that flip,
// independently of continued zoom movement. Computed node-by-node top-down so
// a child can never show before every ancestor has opened.

function applyZoomVisibility(nodes: Node[], zoom: number): Node[] {
  // Sort nodes by depth so parent visibility is computed before children
  const sortedNodes = [...nodes].sort((a, b) => {
    const da = (a.data as any).depth ?? 0
    const db = (b.data as any).depth ?? 0
    return da - db
  })

  const childrenVisibleMap = new Map<string, number>()

  const updatedNodes = sortedNodes.map(node => {
    const parentId = node.parentId

    // Parent visibility drives child visibility
    let selfT = 1
    if (parentId) {
      selfT = childrenVisibleMap.get(parentId) ?? 0
    }

    // Semantic zoom is size-relative: contents appear once this node is
    // rendered REVEAL_CONTAINER_PX across. style dimensions are world-space
    // (canonical × worldScale), so screen size is style × zoom. Nodes with no
    // measurable size never hide their contents.
    const worldW = Number(node.style?.width ?? node.measured?.width ?? 0)
    const worldH = Number(node.style?.height ?? node.measured?.height ?? 0)
    const measurable = worldW > 0 && worldH > 0
    const renderedSize = Math.sqrt(worldW * worldH) * zoom
    const childT = selfT * (!measurable || renderedSize >= REVEAL_CONTAINER_PX ? 1 : 0)

    childrenVisibleMap.set(node.id, childT)

    const scale = 0.92 + 0.08 * selfT
    const blur = (1 - selfT) * 3

    return {
      ...node,
      style: {
        ...node.style,
        opacity:       selfT,
        pointerEvents: selfT > 0.1 ? 'all' : ('none' as any),
        transition:    'opacity 0.25s ease-out',
      },
      data: {
        ...node.data,
        currentZoom: zoom,
        childrenVisible: childT,
        selfScale: scale,
        selfBlur: blur,
      },
    }
  })

  // Maintain original order of nodes for ReactFlow rendering stability
  const updatedNodesMap = new Map<string, Node>(updatedNodes.map(n => [n.id, n]))
  return nodes.map(n => updatedNodesMap.get(n.id) || n)
}

function makeFullyVisible(n: Node): Node {
  return {
    ...n,
    style: { ...n.style, opacity: 1, pointerEvents: 'all' as any },
    data: { ...n.data, selfScale: 1, selfBlur: 0, childrenVisible: 1 },
  }
}

// ─── Layout engine ─────────────────────────────────────────────────────────

interface FloorDescriptor {
  id: string
  nodeType: FloorNodeType
  parentId: string | null
  depth: number
  geometry: ReturnType<typeof normalizeGeometry>
  worldScale: number
}

/**
 * Materialize the Floor as nested coordinate frames. Unlike the legacy layout,
 * this never quantizes authored positions, displaces siblings, or derives
 * visual containment from a drop's semantic side effects.
 */
function buildFloorFrameLayout(
  systems: DbSystem[],
  files: DbFile[],
  infraNodes: DbInfraNode[],
  dependencies: DbDependency[],
  floorLayouts: FloorLayout[],
  agentTouchedIds: Set<string>,
  currentZoom: number,
): { rfNodes: Node[]; rfEdges: Edge[] } {
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

  // A genuinely fresh Floor is packed bottom-up: deepest frames first, each
  // frame sized from its packed contents, so a parent can never be smaller
  // than what it holds and post-hoc growth never creates sibling overlap.
  const freshPackPositions = new Map<string, { x: number; y: number }>()
  const freshPackSizes = new Map<string, { width: number; height: number }>()
  if (initialGraphLayout) {
    const sizeOf = (id: string) => freshPackSizes.get(id) ?? defaultSize(id)
    const depthCache = new Map<string, number>()
    const depthOf = (id: string): number => {
      const cached = depthCache.get(id)
      if (cached !== undefined) return cached
      const parentId = parentById.get(id) ?? null
      const value = parentId ? depthOf(parentId) + 1 : 0
      depthCache.set(id, value)
      return value
    }
    const packedFrames = new Set<string>()
    const packContainer = (containerId: string) => {
      if (packedFrames.has(containerId)) return
      packedFrames.add(containerId)
      const children = siblingsByParent.get(containerId) ?? []
      for (const childId of children) if (siblingsByParent.has(childId)) packContainer(childId)
      if (children.length === 0) return
      const packed = packFrame(
        children.map(childId => ({ id: childId, ...sizeOf(childId) })),
        { baseGap: 36 },
      )
      // The title chrome scales with the frame's presentation scale, and the
      // frame's size depends on the header in turn — iterate to the fixed
      // point so children never start under the rendered title band.
      const base = defaultSize(containerId)
      const depth = depthOf(containerId)
      let header = FRAME_HEADER_HEIGHT
      for (let round = 0; round < 4; round++) {
        const width = Math.max(320, packed.width + FRAME_CONTENT_PADDING * 2)
        const height = Math.max(220, packed.height + header + FRAME_CONTENT_PADDING)
        header = frameHeaderAllowance(width, height, depth, base.width, base.height)
      }
      for (const childId of children) {
        const position = packed.positions.get(childId)!
        freshPackPositions.set(childId, {
          x: FRAME_CONTENT_PADDING + position.x,
          y: header + position.y,
        })
      }
      freshPackSizes.set(containerId, {
        width: Math.max(320, packed.width + FRAME_CONTENT_PADDING * 2),
        height: Math.max(220, packed.height + header + FRAME_CONTENT_PADDING),
      })
    }
    for (const parentKey of siblingsByParent.keys()) {
      if (parentKey) packContainer(parentKey)
    }
  }

  for (const [id, parentId] of parentById) {
    const layout = layoutsById.get(id)
    const fallback = defaultSize(id)
    const semantic = systemsById.get(id) ?? filesById.get(id) ?? infraById.get(id)
    const initialPosition = parentId === null ? initialGraphLayout?.get(id) : undefined
    let x = layout?.positionX ?? initialPosition?.x ?? semantic?.positionX ?? 0
    let y = layout?.positionY ?? initialPosition?.y ?? semantic?.positionY ?? 0
    const occupied = occupiedByParent.get(parentId) ?? []
    if (!layout && x === 0 && y === 0) {
      const fresh = freshPackPositions.get(id)
      if (fresh) {
        x = fresh.x
        y = fresh.y
      } else {
        // A node indexed after the initial layout was persisted clusters in
        // beside its siblings instead of landing on a blind grid.
        const spot = placeIncoming(
          { id, width: fallback.width, height: fallback.height },
          occupied,
          {
            baseGap: parentId ? 36 : 96,
            origin: parentId ? { x: FRAME_CONTENT_PADDING, y: FRAME_HEADER_HEIGHT } : { x: 80, y: 80 },
          },
        )
        x = spot.x
        y = spot.y
      }
    }
    const freshSize = freshPackSizes.get(id)
    const geometry = normalizeGeometry({
      x, y,
      width: layout?.width ?? freshSize?.width ?? fallback.width,
      height: layout?.height ?? freshSize?.height ?? fallback.height,
      scale: layout?.scale ?? 1,
    }, fallback)
    geometryById.set(id, geometry)
    occupied.push({ x: geometry.x, y: geometry.y, width: geometry.width * geometry.scale, height: geometry.height * geometry.scale })
    occupiedByParent.set(parentId, occupied)
  }

  // Initial-index/legacy containers auto-fit their direct children once. A
  // persisted layout is authored and therefore never silently resized.
  for (const [containerId, children] of siblingsByParent) {
    if (!containerId || layoutsById.has(containerId)) continue
    const isContainer = systemsById.has(containerId) || infraById.get(containerId)?.category === 'platform'
    if (!isContainer || children.length === 0) continue
    const container = geometryById.get(containerId)
    if (!container) continue
    let right = 0
    let bottom = 0
    for (const childId of children) {
      const child = geometryById.get(childId)
      if (!child) continue
      right = Math.max(right, child.x + child.width * child.scale)
      bottom = Math.max(bottom, child.y + child.height * child.scale)
    }
    geometryById.set(containerId, {
      ...container,
      width: Math.max(container.width, right + FRAME_CONTENT_PADDING),
      height: Math.max(container.height, bottom + FRAME_CONTENT_PADDING),
    })
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
  const resolveFrame = (id: string): { depth: number; worldScale: number } => {
    const cachedDepth = depthById.get(id)
    const cachedScale = worldScaleById.get(id)
    if (cachedDepth !== undefined && cachedScale !== undefined) return { depth: cachedDepth, worldScale: cachedScale }
    const parentId = parentById.get(id) ?? null
    const parent = parentId ? resolveFrame(parentId) : { depth: -1, worldScale: 1 }
    const result = { depth: parent.depth + 1, worldScale: parent.worldScale * (geometryById.get(id)?.scale ?? 1) }
    depthById.set(id, result.depth)
    worldScaleById.set(id, result.worldScale)
    return result
  }

  const descriptors: FloorDescriptor[] = [...parentById.keys()].map(id => {
    const resolved = resolveFrame(id)
    return { id, nodeType: nodeTypes.get(id)!, parentId: parentById.get(id) ?? null, geometry: geometryById.get(id)!, ...resolved }
  }).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))

  // The badge represents rendered direct children, not separate semantic
  // categories. One authoritative count prevents a descriptor from belonging
  // to overlapping buckets (the old generic child count also included files,
  // despite being passed to SystemNode as `childSystemCount`).
  const directChildCounts = countDirectChildren(descriptors)
  const resizeMinimumFor = (id: string, geometry: ReturnType<typeof normalizeGeometry>, worldScale: number) => {
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

  const rfNodes: Node[] = descriptors.map(descriptor => {
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
  return { rfNodes, rfEdges: [] }
}

function ZoomIndicator() {
  const { zoom } = useViewport()
  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      padding: '6px 12px',
      color: 'var(--text-secondary)',
      fontSize: '12px',
      fontFamily: 'var(--font-mono)',
      fontWeight: 600,
      boxShadow: 'var(--shadow-card)',
      pointerEvents: 'none',
      userSelect: 'none',
    }}>
      Zoom: {zoom.toFixed(2)}x
    </div>
  )
}

// ─── Main component ────────────────────────────────────────────────────────

interface AxiomCanvasProps {
  readOnly?: boolean
}

export function AxiomCanvas({ readOnly = false }: AxiomCanvasProps = {}) {
  const {
    systems, files, infraNodes, dependencies, floorLayouts,
    selectedNodeId, infraPickerNodeId, agentTouchedIds, selectionMode, activeTrace, runtimeNodes, dataFlow,
  } = useGraphStore(useShallow(s => ({
    systems:         s.systems,
    files:           s.files,
    infraNodes:      s.infraNodes,
    dependencies:    s.dependencies,
    floorLayouts:    s.floorLayouts,
    selectedNodeId:  s.selectedNodeId,
    infraPickerNodeId: s.infraPickerNodeId,
    agentTouchedIds: s.agentTouchedIds,
    selectionMode:   s.selectionMode,
    activeTrace:     s.activeTrace,
    runtimeNodes:    s.runtimeNodes,
    dataFlow:        s.dataFlow,
  })))

  const { setSelectedNode, setInspectedNode, setInfraPickerNode, setSelectionMode } = useGraphStore(
    useShallow(s => ({
      setSelectedNode: s.setSelectedNode,
      setInspectedNode: s.setInspectedNode,
      setInfraPickerNode: s.setInfraPickerNode,
      setSelectionMode: s.setSelectionMode,
    }))
  )
  const currentProject = useGraphStore(s => s.currentProject)
  const { fitView, getViewport, setViewport, getInternalNode, screenToFlowPosition } = useReactFlow()

  const [rfNodes, setRfNodes] = useState<Node[]>([])
  const [rfEdges, setRfEdges] = useState<Edge[]>([])
  // Sheet composition also needs the current zoom, so this ref must be
  // initialized before its memoized layout runs.
  const currentZoomRef = useRef(0.5)
  const canvasRootRef = useRef<HTMLDivElement>(null)
  const cursorTraceSignatureRef = useRef('')
  const selectedIdsRef = useRef<Set<string>>(new Set())
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
  }, [])
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [sheetDialogOpen, setSheetDialogOpen] = useState(false)
  // ── Sheet overlay (REVISION 2: sheets are layers over the Floor) ─────────
  // The live canvas is the base layer. When a sheet is active: dim non-member
  // live nodes in place (stencil highlight), draw planned UML elements and
  // planned edges on top. Live members keep their Floor positions.
  const overlaySheetId = useSheetStore(s => s.activeSheetId)
  const visibleSheetIds = useSheetStore(s => s.visibleSheetIds)
  const layersById = useSheetStore(s => s.layersById)
  const overlayElements = useSheetStore(s => s.elements)
  const workspaceIdForOverlay = useGraphStore(s => s.currentProject?.id ?? '')

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
  const activeNodeIds = useMemo(() => new Set([
    ...activeElementByNodeId.keys(),
    ...activePlannedByNodeId.keys(),
  ]), [activeElementByNodeId, activePlannedByNodeId])
  const [isTransitioningLayout, setIsTransitioningLayout] = useState(false)

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

    const memberIds = new Set(effectiveElements.keys())
    const visiblePlanned = overlayPlanned.filter(p => p.status !== 'flattened')
    const plannedSystems: DbSystem[] = visiblePlanned
      .filter(p => p.kind === 'system' || (p.kind === 'infra' && (plannedMetadata(p).capabilities?.includes('container') || plannedMetadata(p).category === 'platform')))
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
    // A live system used as a sheet-local parent must keep its existing Floor
    // subtree visible. Otherwise its children remain in the flattened base
    // projection and are painted behind the now-opaque composed system body.
    const contextSystemIds = new Set<string>()
    for (const element of effectiveElements.values()) {
      if (element.systemId) contextSystemIds.add(element.systemId)
      if (element.parentSystemId && !element.parentSystemId.startsWith('planned:')) {
        contextSystemIds.add(element.parentSystemId)
      }
    }
    for (const planned of visiblePlanned) {
      if (planned.parentSystemId && !planned.parentSystemId.startsWith('planned:')) {
        contextSystemIds.add(planned.parentSystemId)
      }
    }
    const liveSystemById = new Map(systems.map(system => [system.id, system]))
    for (const id of [...contextSystemIds]) {
      let parentId = liveSystemById.get(id)?.parentId ?? null
      const seen = new Set<string>([id])
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId)
        contextSystemIds.add(parentId)
        parentId = liveSystemById.get(parentId)?.parentId ?? null
      }
    }
    let addedContextDescendant = true
    while (addedContextDescendant) {
      addedContextDescendant = false
      for (const system of systems) {
        if (!system.parentId || !contextSystemIds.has(system.parentId) || contextSystemIds.has(system.id)) continue
        contextSystemIds.add(system.id)
        addedContextDescendant = true
      }
    }
    // Containers are structural context: a selected file remains inside its
    // sheet-local parent even when that system was not explicitly selected.
    const requiredSystemIds = new Set<string>()
    for (const [nodeId, element] of effectiveElements) {
      if (element.systemId) requiredSystemIds.add(nodeId)
      if (element.parentSystemId) requiredSystemIds.add(element.parentSystemId)
    }
    for (const system of plannedSystems) {
      requiredSystemIds.add(system.id)
      if (system.parentId) requiredSystemIds.add(system.parentId)
    }
    for (const p of visiblePlanned) {
      if (p.parentSystemId) requiredSystemIds.add(p.parentSystemId)
    }
    for (const id of contextSystemIds) requiredSystemIds.add(id)
    let addedAncestor = true
    while (addedAncestor) {
      addedAncestor = false
      for (const system of systems) {
        if (!requiredSystemIds.has(system.id) || !system.parentId || requiredSystemIds.has(system.parentId)) continue
        requiredSystemIds.add(system.parentId)
        addedAncestor = true
      }
    }
    const systemsById = new Map(systems.map(s => [s.id, s]))
    const getFloorAbsolutePosition = (id: string, type: 'system' | 'file'): { x: number; y: number } => {
      if (type === 'file') {
        const f = files.find(x => x.id === id)
        if (!f) return { x: 0, y: 0 }
        if (!f.systemId) return { x: f.positionX, y: f.positionY }
        const parentPos = getFloorAbsolutePosition(f.systemId, 'system')
        return { x: parentPos.x + f.positionX, y: parentPos.y + f.positionY }
      }
      let x = 0
      let y = 0
      let currentId: string | null = id
      const visited = new Set<string>()
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId)
        const system = systemsById.get(currentId)
        if (!system) break
        x += system.positionX
        y += system.positionY
        currentId = system.parentId
      }
      return { x, y }
    }

    const virtualSystems: DbSystem[] = systems
      .filter(s => requiredSystemIds.has(s.id))
      .map(s => {
        const e = effectiveElements.get(s.id)
        return e
          ? { ...s, parentId: e.parentSystemId, positionX: e.positionX, positionY: e.positionY }
          : { ...s }
      })
      .concat(plannedSystems)
    const virtualSystemIds = new Set(virtualSystems.map(s => s.id))
    const virtualSystemById = new Map(virtualSystems.map(s => [s.id, s]))
    for (const sys of virtualSystems) {
      if (sys.parentId && (!virtualSystemIds.has(sys.parentId) || sys.parentId === sys.id)) {
        if (!sys.id.startsWith('planned:')) {
          const abs = getFloorAbsolutePosition(sys.id, 'system')
          sys.positionX = abs.x
          sys.positionY = abs.y
        }
        sys.parentId = null
      }
      const visited = new Set<string>([sys.id])
      let parentId = sys.parentId
      while (parentId) {
        if (visited.has(parentId)) {
          sys.parentId = null
          break
        }
        visited.add(parentId)
        parentId = virtualSystemById.get(parentId)?.parentId ?? null
      }
    }
    const depthFor = (system: DbSystem): number => {
      let depth = 0
      let parentId = system.parentId
      const seen = new Set([system.id])
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId)
        depth++
        parentId = virtualSystemById.get(parentId)?.parentId ?? null
      }
      return depth
    }
    for (const system of virtualSystems) system.depth = depthFor(system)

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
          systemId: p.parentSystemId && virtualSystemIds.has(p.parentSystemId) ? p.parentSystemId : null,
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
    const virtualFiles: DbFile[] = files
      .filter(f => memberIds.has(f.id) || Boolean(f.systemId && contextSystemIds.has(f.systemId)))
      .map(f => {
        const e = effectiveElements.get(f.id)
        if (!e) {
          const parentId = f.systemId && virtualSystemIds.has(f.systemId) ? f.systemId : null
          if (!parentId && f.systemId) {
            const abs = getFloorAbsolutePosition(f.id, 'file')
            return { ...f, systemId: null, positionX: abs.x, positionY: abs.y }
          }
          return { ...f, systemId: parentId }
        }
        return {
          ...f,
          systemId: e.parentSystemId && virtualSystemIds.has(e.parentSystemId) ? e.parentSystemId : null,
          positionX: e.positionX,
          positionY: e.positionY,
        }
      })
      .concat(plannedFiles)
    const plannedInfra: DbInfraNode[] = visiblePlanned
      .filter(p => p.kind === 'infra' && !(plannedMetadata(p).capabilities?.includes('container') || plannedMetadata(p).category === 'platform'))
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
    const virtualInfra = infraNodes
      .filter(n => memberIds.has(n.id))
      .map(n => {
        const e = effectiveElements.get(n.id)!
        return { ...n, positionX: e.positionX, positionY: e.positionY }
      })
      .concat(plannedInfra)
    const sheetFrameLayouts: FloorLayout[] = [
      ...virtualSystems.map(system => {
        const element = effectiveElements.get(system.id)
        const planned = system.id.startsWith('planned:') ? visiblePlannedByNodeId.get(system.id) : undefined
        return {
          workspaceId: workspaceIdForOverlay, nodeId: system.id, nodeType: 'system' as const,
          parentNodeId: element?.parentSystemId ?? planned?.parentSystemId ?? system.parentId,
          parentNodeType: (element?.parentSystemId ?? planned?.parentSystemId ?? system.parentId) ? 'system' as const : null,
          containmentKind: (element?.parentSystemId ?? planned?.parentSystemId ?? system.parentId) ? 'part_of' as const : 'root' as const,
          positionX: element?.positionX ?? planned?.positionX ?? system.positionX,
          positionY: element?.positionY ?? planned?.positionY ?? system.positionY,
          width: element?.width ?? planned?.width ?? system.width ?? 620,
          height: element?.height ?? planned?.height ?? system.height ?? 420,
          scale: element?.scale ?? planned?.scale ?? 1, updatedAt: 0,
        }
      }),
      ...virtualFiles.map(file => {
        const element = effectiveElements.get(file.id)
        const planned = file.id.startsWith('planned:') ? visiblePlannedByNodeId.get(file.id) : undefined
        const parentId = element?.parentSystemId ?? planned?.parentSystemId ?? file.systemId
        return {
          workspaceId: workspaceIdForOverlay, nodeId: file.id, nodeType: 'file' as const,
          parentNodeId: parentId, parentNodeType: parentId ? 'system' as const : null,
          containmentKind: parentId ? 'part_of' as const : 'root' as const,
          positionX: element?.positionX ?? planned?.positionX ?? file.positionX,
          positionY: element?.positionY ?? planned?.positionY ?? file.positionY,
          width: element?.width ?? planned?.width ?? file.width ?? BASE_FILE_W,
          height: element?.height ?? planned?.height ?? file.height ?? BASE_FILE_H,
          scale: element?.scale ?? planned?.scale ?? 1, updatedAt: 0,
        }
      }),
      ...virtualInfra.map(infra => {
        const element = effectiveElements.get(infra.id)
        const planned = infra.id.startsWith('planned:') ? visiblePlannedByNodeId.get(infra.id) : undefined
        const parentId = element?.parentSystemId ?? planned?.parentSystemId ?? null
        return {
          workspaceId: workspaceIdForOverlay, nodeId: infra.id, nodeType: 'infra' as const,
          parentNodeId: parentId, parentNodeType: parentId ? 'system' as const : null,
          containmentKind: parentId ? 'part_of' as const : 'root' as const,
          positionX: element?.positionX ?? planned?.positionX ?? infra.positionX,
          positionY: element?.positionY ?? planned?.positionY ?? infra.positionY,
          width: element?.width ?? planned?.width ?? (infra.category === 'platform' ? 760 : 260),
          height: element?.height ?? planned?.height ?? (infra.category === 'platform' ? 520 : 160),
          scale: element?.scale ?? planned?.scale ?? 1, updatedAt: 0,
        }
      }),
    ]
    const sheetLayout = applyZoomVisibility(buildFloorFrameLayout(
      virtualSystems, virtualFiles, virtualInfra, dependencies, sheetFrameLayouts,
      agentTouchedIds, currentZoomRef.current,
    ).rfNodes, currentZoomRef.current)
    const floorById = new Map(rfNodes.map(n => [n.id, n]))
    const floorAbsolutePositions = new Map<string, { x: number; y: number }>()
    const floorAbsolutePosition = (node: Node, visiting = new Set<string>()): { x: number; y: number } => {
      const cached = floorAbsolutePositions.get(node.id)
      if (cached) return cached
      if (!node.parentId || visiting.has(node.id)) {
        const root = { x: node.position.x, y: node.position.y }
        floorAbsolutePositions.set(node.id, root)
        return root
      }
      const parent = floorById.get(node.parentId)
      if (!parent) {
        const root = { x: node.position.x, y: node.position.y }
        floorAbsolutePositions.set(node.id, root)
        return root
      }
      const nextVisiting = new Set(visiting).add(node.id)
      const parentPosition = floorAbsolutePosition(parent, nextVisiting)
      const absolute = { x: parentPosition.x + node.position.x, y: parentPosition.y + node.position.y }
      floorAbsolutePositions.set(node.id, absolute)
      return absolute
    }
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
      const isStructuralFloorContext = Boolean(
        floorNode && sheetNode.type === 'system' && !effectiveElements.has(sheetNode.id),
      )
      const sheetW = parseFloat(String(sheetNode.style?.width ?? 0))
      const sheetH = parseFloat(String(sheetNode.style?.height ?? 0))
      const floorW = parseFloat(String(floorNode?.style?.width ?? 0))
      const floorH = parseFloat(String(floorNode?.style?.height ?? 0))
      const renderedW = isStructuralFloorContext ? Math.max(sheetW, floorW) : sheetW
      const renderedH = isStructuralFloorContext ? Math.max(sheetH, floorH) : sheetH
      return {
        ...sheetNode,
        selected: selectedIdsRef.current.has(sheetNode.id) || sheetNode.id === selectedNodeId,
        data: {
          ...sheetNode.data,
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
          ...(isFloorContextNode ? {
            opacity: Math.min(nodeOpacity, 0.45),
            pointerEvents: 'none' as const,
          } : {}),
          transition,
        },
        draggable: activeNodeIds.has(sheetNode.id) && nodeOpacity > 0.1,
        selectable: !isFloorContextNode && nodeOpacity > 0.1,
        zIndex: sheetNode.id.startsWith('planned:') ? 10000 : sheetNode.zIndex,
      }
    })
    const sheetIds = new Set(sheetLayout.map(n => n.id))
    const dimmedFloor = rfNodes.flatMap(n => {
      if (sheetIds.has(n.id)) return []
      const floorOpacity = typeof n.style?.opacity === 'number' ? n.style.opacity : 1
      return [{
        ...n,
        // The Floor is a projected base layer. Flatten its non-sheet nodes to
        // absolute coordinates so a sheet-local system cannot capture and
        // recursively transform the live system's Floor descendants.
        parentId: undefined,
        position: floorAbsolutePosition(n),
        // Keep the Floor legible beneath a sheet without reviving descendants
        // that semantic zoom has intentionally hidden.
        style: { ...n.style, opacity: Math.min(floorOpacity, 0.45), pointerEvents: 'none' as const, transition },
        selectable: false, draggable: false,
      }]
    })
    return [...dimmedFloor, ...morphed]
  }, [rfNodes, visibleLayers, effectiveElements, activeElementByNodeId, systems, files, infraNodes, dependencies, agentTouchedIds, overlayPlanned, isTransitioningLayout, visiblePlannedByNodeId, activePlannedByNodeId, activeNodeIds, selectedNodeId, workspaceIdForOverlay, setInfraPickerNode])

  const [sheetInteractionNodes, setSheetInteractionNodes] = useState<Node[] | null>(null)
  useEffect(() => setSheetInteractionNodes(null), [overlaySheetId, visibleSheetIds.join('|')])
  const displayNodes = sheetInteractionNodes ?? composedNodes
  const displayNodesRef = useRef<Node[]>(displayNodes)
  displayNodesRef.current = displayNodes

  const updateInteractiveNodes = useCallback((updater: (nodes: Node[]) => Node[]) => {
    if (useSheetStore.getState().activeSheetId) {
      setSheetInteractionNodes(current => updater(current ?? displayNodesRef.current))
    } else {
      setRfNodes(updater)
    }
  }, [])

  const displayEdges = useMemo(() => {
    if (visibleLayers.length === 0) return rfEdges
    const plannedRf: Edge[] = overlayPlannedEdges.map(e => ({
      id: `pedge:${e.id}`,
      source: e.srcPlanned ? `planned:${e.srcPlanned}` : (e.srcLive ?? ''),
      target: e.dstPlanned ? `planned:${e.dstPlanned}` : (e.dstLive ?? ''),
      label: e.kind,
      animated: true,
      style: { strokeDasharray: '6 4', stroke: 'var(--accent)' },
      labelStyle: { fontSize: 8, fontFamily: 'var(--font-mono)', fill: 'var(--text-secondary)' },
      zIndex: 10000,
    }))
    const visibleIds = new Set(displayNodes.filter(n => n.style?.opacity !== 0).map(n => n.id))
    return [
      ...rfEdges.map(e => visibleIds.has(e.source) && visibleIds.has(e.target)
        ? e
        : { ...e, style: { ...e.style, opacity: 0 }, selectable: false }),
      ...plannedRf,
    ]
  }, [rfEdges, visibleLayers, overlayPlannedEdges, displayNodes])

  // Stencil drop: palette → canvas → planned element born in name-edit mode.
  const onOverlayDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/axiom-stencil')) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])
  const onOverlayDrop = useCallback((e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/axiom-stencil')
    if (!raw || !overlaySheetId) return
    e.preventDefault()
    e.stopPropagation()
    const stencil = JSON.parse(raw) as StencilDef
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const store = useSheetStore.getState()
    if (stencil.shape === 'note') {
      void store.createFloatingNote(workspaceIdForOverlay, overlaySheetId, 'New note — double-click to edit', pos.x, pos.y)
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
  }, [overlaySheetId, workspaceIdForOverlay, screenToFlowPosition, setSelectedNode, setInfraPickerNode])

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
      scheduleTimeout(() => fitView({ padding: 0.12, duration: 400 }), 100)
    } catch (err) {
      console.error('[AxiomCanvas] Tidy layout failed', err)
    } finally {
      setIsTidying(false)
    }
  }, [systems, files, infraNodes, dependencies, currentProject, fitView])

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
      const parentScale = selectedContainer ? Number((selectedContainer.data as any).worldScale ?? 1) : 1
      const parentCanonical = selectedContainer ? {
        width: Number(selectedContainer.style?.width ?? selectedContainer.measured?.width ?? 1) / parentScale,
        height: Number(selectedContainer.style?.height ?? selectedContainer.measured?.height ?? 1) / parentScale,
      } : { width: 2600, height: 1800 }
      const containerData = selectedContainer?.data as Record<string, unknown> | undefined
      const headerAllowance = frameHeaderAllowance(
        parentCanonical.width,
        parentCanonical.height,
        Number(containerData?.depth ?? 0),
        containerData?.presentationBaseWidth != null ? Number(containerData.presentationBaseWidth) / parentScale : 620,
        containerData?.presentationBaseHeight != null ? Number(containerData.presentationBaseHeight) / parentScale : 420,
      )
      const content = scopeId ? contentRect(parentCanonical, FRAME_CONTENT_PADDING, headerAllowance) : { x: 80, y: 80, width: parentCanonical.width - 160, height: parentCanonical.height - 160 }
      const packed = packFrame(
        children.map(child => ({
          id: child.id,
          width: Number(child.style?.width ?? child.measured?.width ?? BASE_FILE_W) / parentScale,
          height: Number(child.style?.height ?? child.measured?.height ?? BASE_FILE_H) / parentScale,
        })),
        {
          baseGap: 42,
          aspect: content.width / Math.max(1, content.height),
        },
      )
      const positions = new Map<string, { x: number; y: number }>()
      for (const child of children) {
        const position = packed.positions.get(child.id)!
        positions.set(child.id, { x: content.x + position.x, y: content.y + position.y })
      }

      const sheet = useSheetStore.getState()
      if (sheet.activeSheetId) {
        const mutations: SheetLayoutMutation[] = children.flatMap(child => {
          const position = positions.get(child.id)!
          const element = sheet.elements.find(item => (item.systemId ?? item.fileId ?? item.infraId) === child.id)
          const planned = child.id.startsWith('planned:') ? sheet.planned.find(item => item.id === child.id.slice(8)) : undefined
          if (!element && !planned) return []
          return [{
            kind: element ? 'element' as const : 'planned' as const,
            id: element?.id ?? planned!.id,
            x: position.x, y: position.y, parentSystemId: scopeId,
            width: Number(element?.width ?? planned?.width ?? child.style?.width ?? BASE_FILE_W),
            height: Number(element?.height ?? planned?.height ?? child.style?.height ?? BASE_FILE_H),
            scale: element?.scale ?? planned?.scale ?? 1,
          }]
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
          }
        })
        await apiSaveFloorLayouts(workspaceId, updates)
        const saved = updates.map(update => ({ ...update, workspaceId, updatedAt: Date.now() }))
        const changed = new Set(saved.map(item => item.nodeType + ':' + item.nodeId))
        useGraphStore.setState(state => ({
          floorLayouts: [...state.floorLayouts.filter(item => !changed.has(item.nodeType + ':' + item.nodeId)), ...saved],
        }))
      }
      scheduleTimeout(() => fitView({ padding: 0.12, duration: 400 }), 80)
    } catch (error) {
      console.error('[AxiomCanvas] tidy frame failed', error)
    } finally {
      setIsTidying(false)
    }
  }, [fitView, selectedNodeId, workspaceIdForOverlay])

  const zoomRafRef        = useRef<number | null>(null)
  const layoutBuiltRef = useRef<string | null>(null)
  const initialFloorPersistRef = useRef<string | null>(null)
  const heldKeysRef       = useRef<Set<string>>(new Set())
  const wasdRafRef        = useRef<number | null>(null)
  const resizeStartRef    = useRef<Map<string, NodeResizeParams & { children: Map<string, { x: number; y: number }> }>>(new Map())
  const resizingNodeIdRef = useRef<string | null>(null)
  const rfNodesRef        = useRef<Node[]>([])
  const dropTargetRef     = useRef<string | null>(null)
  const draggingNodeIdRef = useRef<string | null>(null)
  const dragPositionRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  const dragTraceSessionRef = useRef(0)
  const dragTraceRef = useRef<NodeMoveTrace | null>(null)
  const targetZoomRef      = useRef<number | null>(null)
  const targetViewportRef  = useRef<{ x: number; y: number } | null>(null)
  const smoothZoomRafRef   = useRef<number | null>(null)
  const smoothZoomMouseRef = useRef<{ mx: number; my: number } | null>(null)

  rfNodesRef.current = rfNodes

  // ── Node resize ──────────────────────────────────────────────────────────
  const armResizeEndFallback = useCallback((nodeId: string) => {
    // XYFlow intentionally omits onResizeEnd when a handle is pressed and
    // released without a drag. Clear our interaction session after pointer-up
    // only if the normal end callback did not already consume it.
    const onPointerUp = () => requestAnimationFrame(() => {
      if (!resizeStartRef.current.has(nodeId)) return
      resizeStartRef.current.delete(nodeId)
      if (resizingNodeIdRef.current === nodeId) resizingNodeIdRef.current = null
      if (useSheetStore.getState().activeSheetId) setSheetInteractionNodes(null)
    })
    window.addEventListener('pointerup', onPointerUp, { once: true, capture: true })
  }, [])

  const onNodeResizeEnd = useCallback((nodeId: string, end: NodeResizeParams) => {
    const start = resizeStartRef.current.get(nodeId)
    resizeStartRef.current.delete(nodeId)
    requestAnimationFrame(() => {
      if (resizingNodeIdRef.current === nodeId) resizingNodeIdRef.current = null
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
    const node = (sheetState.activeSheetId ? displayNodesRef.current : rfNodesRef.current).find(n => n.id === nodeId)
    if (!node) {
      if (sheetState.activeSheetId) setSheetInteractionNodes(null)
      return
    }

    const parentId = node.parentId
    const ownScale = Number((node.data as any).frameScale ?? 1)
    const worldScale = Number((node.data as any).worldScale ?? ownScale)
    const canonical = toCanonicalResizeGeometry(end, worldScale, ownScale, !!parentId)

    // Sheets already store canonical local geometry. Resizing is intentionally
    // freeform: no grid units and no sibling displacement.
    if (sheetState.activeSheetId) {
      const sheetId = sheetState.activeSheetId
      const mutationFor = (
        renderedId: string,
        x: number,
        y: number,
        parentSystemId: string | null,
        size?: { width: number; height: number; scale: number },
      ): SheetLayoutMutation | null => {
        const member = sheetState.elements.find(item => (item.systemId ?? item.fileId ?? item.infraId) === renderedId)
        if (member) return { kind: 'element', id: member.id, x, y, parentSystemId, ...size }
        const plannedNode = renderedId.startsWith('planned:')
          ? sheetState.planned.find(item => item.id === renderedId.slice(8))
          : undefined
        return plannedNode ? { kind: 'planned', id: plannedNode.id, x, y, parentSystemId, ...size } : null
      }
      const parentMutation = mutationFor(nodeId, canonical.x, canonical.y, parentId ?? null, {
        width: canonical.width,
        height: canonical.height,
        scale: ownScale,
      })
      const childMutations = [...start.children].flatMap(([childId, childStart]) => {
        const position = childPositionAfterParentResize(childStart, start, end, worldScale)
        const mutation = mutationFor(childId, position.x, position.y, nodeId)
        return mutation ? [mutation] : []
      })
      if (sheetId && parentMutation) {
        void sheetState.updateLayoutsBatch(workspaceIdForOverlay, sheetId, [parentMutation, ...childMutations]).catch(() => {})
      }
      setSheetInteractionNodes(null)
      return
    }

    const graph = useGraphStore.getState()
    const workspaceId = graph.currentProject?.id
    if (!workspaceId) return
    const nodeType: FloorNodeType = graph.systems.some(system => system.id === nodeId)
      ? 'system' : graph.files.some(file => file.id === nodeId) ? 'file' : 'infra'
    const previous = graph.floorLayouts.find(layout => layout.nodeId === nodeId && layout.nodeType === nodeType)
    const parentType = parentId ? (graph.infraNodes.some(infra => infra.id === parentId) ? 'infra' : 'system') : null
    const nextLayout: Omit<FloorLayout, 'workspaceId' | 'updatedAt'> = {
      nodeId, nodeType, parentNodeId: parentId ?? null, parentNodeType: parentType,
      containmentKind: parentType === 'infra' ? 'hosted_by' : parentType === 'system' ? 'part_of' : 'root',
      positionX: canonical.x,
      positionY: canonical.y,
      width: canonical.width,
      height: canonical.height,
      scale: ownScale,
    }
    const childLayouts: Omit<FloorLayout, 'workspaceId' | 'updatedAt'>[] = [...start.children].flatMap(([childId, childStart]) => {
      const childNode = rfNodesRef.current.find(candidate => candidate.id === childId)
      if (!childNode) return []
      const childType: FloorNodeType = graph.systems.some(system => system.id === childId)
        ? 'system' : graph.files.some(file => file.id === childId) ? 'file' : 'infra'
      const childPrevious = graph.floorLayouts.find(layout => layout.nodeId === childId && layout.nodeType === childType)
      const childOwnScale = childPrevious?.scale ?? Number((childNode.data as any).frameScale ?? 1)
      const childWorldScale = Number((childNode.data as any).worldScale ?? worldScale * childOwnScale)
      const position = childPositionAfterParentResize(childStart, start, end, worldScale)
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
      }]
    })
    const updates = [nextLayout, ...childLayouts]
    const changed = new Set(updates.map(layout => `${layout.nodeType}:${layout.nodeId}`))
    const previousLayouts = graph.floorLayouts.filter(layout => changed.has(`${layout.nodeType}:${layout.nodeId}`))
    const optimistic = updates.map(layout => ({ ...layout, workspaceId, updatedAt: Date.now() }))
    useGraphStore.setState(state => ({
      floorLayouts: [...state.floorLayouts.filter(layout => !changed.has(`${layout.nodeType}:${layout.nodeId}`)), ...optimistic],
    }))
    void apiSaveFloorLayouts(workspaceId, updates).catch(error => {
      console.error('[AxiomCanvas] floor resize failed', error)
      useGraphStore.setState(state => ({
        floorLayouts: [...state.floorLayouts.filter(layout => !changed.has(`${layout.nodeType}:${layout.nodeId}`)), ...previousLayouts],
      }))
    })
    return

  }, [workspaceIdForOverlay])

  useEffect(() => {
    if (systems.length === 0 && infraNodes.length === 0) return

    const projectId = currentProject?.id ?? 'demo'
    // On first layout for a project, don't use existing positions — force fresh grid layout.
    // On subsequent data updates (same project), preserve user-dragged positions.
    const isFirstLayout = layoutBuiltRef.current !== projectId
    const existingNodes = isFirstLayout ? [] : rfNodes

    const { rfNodes: layout, rfEdges: newEdges } = buildFloorFrameLayout(
      systems, files, infraNodes, dependencies, floorLayouts,
      agentTouchedIds, currentZoomRef.current,
    )

    // A genuinely empty Floor gets one relationship-aware initialization.
    // Persist the complete result immediately; after this, authored freeform
    // geometry is the sole source of truth and the force layout never reruns.
    if (!readOnly && currentProject && floorLayouts.length === 0 && initialFloorPersistRef.current !== projectId) {
      initialFloorPersistRef.current = projectId
      const initialLayouts: Omit<FloorLayout, 'workspaceId' | 'updatedAt'>[] = layout.map(node => {
        const nodeType: FloorNodeType = systems.some(system => system.id === node.id)
          ? 'system' : files.some(file => file.id === node.id) ? 'file' : 'infra'
        const ownScale = Number((node.data as any).frameScale ?? 1)
        const worldScale = Number((node.data as any).worldScale ?? ownScale)
        const parentWorldScale = node.parentId ? worldScale / Math.max(0.0001, ownScale) : 1
        const parentNodeType = node.parentId
          ? (infraNodes.some(infra => infra.id === node.parentId) ? 'infra' : 'system')
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
        }
      })
      const optimistic = initialLayouts.map(item => ({ ...item, workspaceId: currentProject.id, updatedAt: Date.now() }))
      useGraphStore.setState({ floorLayouts: optimistic })
      void apiSaveFloorLayouts(currentProject.id, initialLayouts).catch(error => {
        console.error('[AxiomCanvas] initial Floor layout failed', error)
        initialFloorPersistRef.current = null
        useGraphStore.setState({ floorLayouts: [] })
      })
    }

    const layoutWithCallbacks = layout.map(n => ({
      ...n,
      data: {
        ...n.data,
        onResizeStart: readOnly ? undefined : (params: NodeResizeParams) => {
          // Resize geometry must never compete with a sheet/layout morph.
          // Otherwise the previous larger frame remains composited behind the
          // live frame and reads as a resize ghost.
          setIsTransitioningLayout(false)
          resizingNodeIdRef.current = n.id
          draggingNodeIdRef.current = null
          dragPositionRef.current.delete(n.id)
          const children = new Map(rfNodesRef.current
            .filter(child => child.parentId === n.id)
            .map(child => [child.id, { x: child.position.x, y: child.position.y }]))
          resizeStartRef.current.set(n.id, { ...params, children })
          armResizeEndFallback(n.id)
        },
        onResizeEnd: readOnly ? undefined : (params: NodeResizeParams) => onNodeResizeEnd(n.id, params),
      },
    }))
    const withZoom = applyZoomVisibility(layoutWithCallbacks, currentZoomRef.current)
    const fixed = withZoom.map(node => ({
      ...node,
      selected: selectedIdsRef.current.has(node.id) || node.id === selectedNodeId,
    }))
    setRfNodes(fixed)
    setRfEdges(newEdges)
    // Signal overlay effects (runtime / focus / trace) to restamp their
    // per-node flags, which this full rebuild just discarded.
    setLayoutVersion(v => v + 1)

    if (isFirstLayout) {
      layoutBuiltRef.current = projectId
      scheduleTimeout(() => fitView({ padding: 0.12, duration: 400 }), 80)
    }
  }, [systems, files, infraNodes, floorLayouts, dependencies, selectionMode, onNodeResizeEnd, armResizeEndFallback])

  useEffect(() => {
    setRfNodes(curr => curr.map(n => ({ ...n, selected: n.id === selectedNodeId })))
  }, [selectedNodeId])

  useEffect(() => {
    setRfNodes(curr => curr.map(n => ({
      ...n, data: { ...n.data, agentTouched: agentTouchedIds.has(n.id) },
    })))
  }, [agentTouchedIds])

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
  // added/removed or the trace changes — not on every runtime metric tick. This
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
      markerEnd: { type: MarkerType.ArrowClosed, color: '#22d3ee', width: 16, height: 16 },
      style: { stroke: '#22d3ee', strokeWidth: 2 },
      label: step.callerSymbol && step.calleeSymbol
        ? `${step.callerSymbol} → ${step.calleeSymbol}`
        : undefined,
      labelStyle: { fill: '#22d3ee', fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: 'rgba(10,13,20,0.85)', rx: 4 },
      zIndex: 1000,
    }))
    setRfEdges(curr => [...curr.filter(e => !e.id.startsWith('trace-')), ...traceEdges])
  }, [activeTrace, layoutVersion])

  // ── WASD pan ────────────────────────────────────────────────────────────
  useEffect(() => {
    const PAN_SPEED = 8
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return
      const key = e.key.toLowerCase()
      if (!['w', 'a', 's', 'd'].includes(key)) return
      e.preventDefault()
      heldKeysRef.current.add(key)
      if (wasdRafRef.current) return
      const loop = () => {
        const keys = heldKeysRef.current
        if (keys.size === 0) { wasdRafRef.current = null; return }
        let dx = 0, dy = 0
        if (keys.has('a')) dx += PAN_SPEED
        if (keys.has('d')) dx -= PAN_SPEED
        if (keys.has('w')) dy += PAN_SPEED
        if (keys.has('s')) dy -= PAN_SPEED
        if (dx !== 0 || dy !== 0) {
          const vp = getViewport()
          setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom })
        }
        wasdRafRef.current = requestAnimationFrame(loop)
      }
      wasdRafRef.current = requestAnimationFrame(loop)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      heldKeysRef.current.delete(e.key.toLowerCase())
      if (heldKeysRef.current.size === 0 && wasdRafRef.current) {
        cancelAnimationFrame(wasdRafRef.current)
        wasdRafRef.current = null
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      if (wasdRafRef.current) { cancelAnimationFrame(wasdRafRef.current); wasdRafRef.current = null }
    }
  }, [getViewport, setViewport])

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
    // Check if target or any ancestor is marked "nowheel"
    let target = e.target as HTMLElement | null
    while (target) {
      if (target.classList?.contains('nowheel')) return
      target = target.parentElement
    }

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

    // Accumulate the zoom target based on scroll direction
    const factor = 1.15
    if (e.deltaY < 0) {
      targetZoomRef.current = Math.min(MAX_CANVAS_ZOOM, targetZoomRef.current * factor)
    } else {
      targetZoomRef.current = Math.max(MIN_CANVAS_ZOOM, targetZoomRef.current / factor)
    }

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

        const step = 0.15
        const newZ = vp.zoom + (tz - vp.zoom) * step

        // Compute coordinate under the mouse cursor relative to current viewport
        const cx = (mouse.mx - vp.x) / vp.zoom
        const cy = (mouse.my - vp.y) / vp.zoom

        // Compute new viewport position matching this new zoom
        const newX = mouse.mx - cx * newZ
        const newY = mouse.my - cy * newZ

        setViewport({ x: newX, y: newY, zoom: newZ })

        // Stop the animation if we are very close to target zoom
        if (Math.abs(newZ - tz) < 0.005) {
          // Final snap
          const finalVp = getViewport()
          const finalCx = (mouse.mx - finalVp.x) / finalVp.zoom
          const finalCy = (mouse.my - finalVp.y) / finalVp.zoom
          const finalX = mouse.mx - finalCx * tz
          const finalY = mouse.my - finalCy * tz
          setViewport({ x: finalX, y: finalY, zoom: tz })

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

    // A sheet interaction snapshot must never outlive the geometry mutation
    // that created it, or it freezes semantic zoom on stale node styles.
    if (useSheetStore.getState().activeSheetId && !draggingNodeIdRef.current && resizeStartRef.current.size === 0) {
      setSheetInteractionNodes(null)
    }

    // Cancel smooth zoom animation if movement is driven by user interaction (drag, pinch, etc.)
    if (event) {
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
      setRfNodes(curr => {
        const updated = applyZoomVisibility(curr, zoom)
        if (!draggingId) return updated
        return updated.map(n => n.id === draggingId ? makeFullyVisible(n) : n)
      })
    })
  }, [])

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      const moveTrace = dragTraceRef.current
      if (moveTrace) {
        const viewport = getViewport()
        const now = performance.now()
        for (const change of changes) {
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
      for (const change of changes) {
        if (change.type !== 'select') continue
        const next = new Set(selectedIdsRef.current)
        if (change.selected) next.add(change.id)
        else next.delete(change.id)
        selectedIdsRef.current = next
      }
      // North/west resize handles change the frame origin as well as its
      // dimensions. Apply the complete React Flow change set so the edge under
      // the pointer remains under the pointer and child compensation stays live.
      const interactionChanges = changes
      // Planned overlay nodes live in the sheet store, not rfNodes — route
      // their drags there and keep the rest on the normal path.
      if (overlaySheetId) {
        const geometryChanges = interactionChanges.filter(change => change.type === 'position' || change.type === 'select' ||
          (change.type === 'dimensions' && resizeStartRef.current.size > 0))
        if (geometryChanges.length > 0) {
          setSheetInteractionNodes(nodes => applyNodeChanges(geometryChanges, nodes ?? displayNodesRef.current))
        }
      } else {
        setRfNodes(nodes => applyNodeChanges(interactionChanges, nodes))
      }
    }, [getViewport, overlaySheetId]
  )
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setRfEdges(es => applyEdgeChanges(changes, es)), []
  )

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    selectedIdsRef.current = new Set([node.id])
    setSelectedNode(node.id)
    const target = event.target as HTMLElement | null
    if (!target?.closest('input, textarea, select, button, [contenteditable="true"], [data-node-editable="true"]')) {
      setInspectedNode(null)
    }
  }, [setSelectedNode, setInspectedNode])

  const onNodeDoubleClick = useCallback((event: React.MouseEvent, node: Node) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, select, button, [contenteditable="true"], [data-node-editable="true"]')) return
    setSelectedNode(node.id)
    setInspectedNode(node.id)
  }, [setSelectedNode, setInspectedNode])

  const onPaneClick = useCallback(() => {
    selectedIdsRef.current = new Set()
    setSelectedNode(null)
    setInspectedNode(null)
  }, [setSelectedNode, setInspectedNode])

  // ── Drag visibility override ─────────────────────────────────────────────
  const onNodeDragStart: OnNodeDrag = useCallback((event, node) => {
    if (resizingNodeIdRef.current === node.id) return
    setIsTransitioningLayout(false)
    draggingNodeIdRef.current = node.id
    dragPositionRef.current.set(node.id, { x: node.position.x, y: node.position.y })
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
    updateInteractiveNodes(curr => curr.map(n => n.id === node.id ? makeFullyVisible(n) : n))

  }, [getInternalNode, getViewport, screenToFlowPosition, updateInteractiveNodes])

  const onNodeDrag: OnNodeDrag = useCallback((event, node) => {
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

    // Freeform hit-testing: choose the smallest eligible frame under the
    // cursor. No barriers, cell snapping, sibling displacement, or DOM nudges.
    dragPositionRef.current.set(node.id, { x: node.position.x, y: node.position.y })
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
      if (overlaySheetId && !activeNodeIds.has(candidate.id)) return false
      const internal = getInternalNode(candidate.id)
      if (!internal) return false
      const absolute = internal.internals.positionAbsolute
      const width = Number(candidate.measured?.width ?? candidate.style?.width ?? 0)
      const height = Number(candidate.measured?.height ?? candidate.style?.height ?? 0)
      return cursor.x >= absolute.x && cursor.x <= absolute.x + width && cursor.y >= absolute.y && cursor.y <= absolute.y + height
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
  }, [getInternalNode, getViewport, screenToFlowPosition, overlaySheetId, activeNodeIds, updateInteractiveNodes])

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
      console.groupCollapsed(`[AxiomMoveTrace #${moveTrace.session}] COMPLETE — ${node.id}`)
      console.info('Summary and unit conversion', summary)
      console.info('Drag callback samples — pointer input compared with node output')
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
    // Clear drag state — restore zoom visibility, clear drop highlight
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
    if (!useSheetStore.getState().activeSheetId) {
      const graph = useGraphStore.getState()
      const workspaceId = graph.currentProject?.id
      const all = displayNodesRef.current
      const parentById = new Map(all.map(candidate => [candidate.id, candidate.parentId ?? null]))
      const selected = all.filter(candidate => candidate.selected).map(candidate => candidate.id)
      if (!selected.includes(node.id)) selected.push(node.id)
      const roots = highestSelectedRoots(selected, parentById)
        .map(id => all.find(candidate => candidate.id === id))
        .filter((candidate): candidate is Node => !!candidate)
      const targetNode = prevTarget ? all.find(candidate => candidate.id === prevTarget) : null
      const changesParent = !!targetNode && roots.some(root => root.parentId !== targetNode.id)
      // Reparenting changes the destination frame for the entire sibling set.
      // Include the target's current direct children so the existing contents
      // and the incoming selection are fitted as one group, without resizing
      // the target container itself.
      const incomingIds = new Set(roots.map(root => root.id))
      const layoutRoots = changesParent && targetNode
        ? [
            ...all.filter(candidate => candidate.parentId === targetNode.id && !incomingIds.has(candidate.id)),
            ...roots,
          ]
        : roots
      const rootRects = layoutRoots.map(root => {
        const absolute = getInternalNode(root.id)?.internals.positionAbsolute ?? root.position
        return {
          id: root.id, x: absolute.x, y: absolute.y,
          width: Number(root.measured?.width ?? root.style?.width ?? 1),
          height: Number(root.measured?.height ?? root.style?.height ?? 1),
        }
      })
      const targetAbsolute = targetNode
        ? (getInternalNode(targetNode.id)?.internals.positionAbsolute ?? { x: 0, y: 0 })
        : { x: 0, y: 0 }
      const targetWorldScale = targetNode ? Number((targetNode.data as any).worldScale ?? 1) : 1
      const targetContent = targetNode ? contentRect({
        width: Number(targetNode.style?.width ?? targetNode.measured?.width ?? 1) / Math.max(0.0001, targetWorldScale),
        height: Number(targetNode.style?.height ?? targetNode.measured?.height ?? 1) / Math.max(0.0001, targetWorldScale),
      }) : null
      const destination = targetContent ? {
        x: targetAbsolute.x + targetContent.x * targetWorldScale,
        y: targetAbsolute.y + targetContent.y * targetWorldScale,
        width: targetContent.width * targetWorldScale,
        height: targetContent.height * targetWorldScale,
      } : null
      // Preserve the authored reference frame. Existing siblings and incoming
      // roots may overlap; a drop must never repack or otherwise rearrange
      // them. If their combined bounds exceed the destination, the entire
      // frame is translated/scaled uniformly below.
      const placementRects = rootRects
      const groupBounds = boundsOf(placementRects)
      const incomingBounds = boundsOf(rootRects.filter(rect => incomingIds.has(rect.id)))
      const occupiedRects = rootRects.filter(rect => !incomingIds.has(rect.id))
      const incomingOffset = changesParent && destination && incomingBounds
        ? findUnscaledIncomingPlacement(incomingBounds, destination, occupiedRects)
        : null
      const frameTransform = changesParent && !incomingOffset && groupBounds && destination && incomingBounds
        ? fitReferenceFrame(groupBounds, destination, incomingBounds)
        : null
      const fit = frameTransform?.scale ?? 1

      if (workspaceId && groupBounds) {
        const updates: Omit<FloorLayout, 'workspaceId' | 'updatedAt'>[] = layoutRoots.map(root => {
          const nodeType: FloorNodeType = graph.systems.some(system => system.id === root.id)
            ? 'system' : graph.files.some(file => file.id === root.id) ? 'file' : 'infra'
          const previous = graph.floorLayouts.find(layout => layout.nodeId === root.id && layout.nodeType === nodeType)
          const rect = placementRects.find(candidate => candidate.id === root.id)!
          const nextWorld = frameTransform
            ? transformReferencePoint(rect, frameTransform)
            : incomingIds.has(rect.id) && incomingOffset
              ? { x: rect.x + incomingOffset.x, y: rect.y + incomingOffset.y }
              : { x: rect.x, y: rect.y }
          const oldWorldScale = Number((root.data as any).worldScale ?? previous?.scale ?? 1)
          // A legacy/unpersisted container may have been auto-fitted around its
          // children. Preserve that materialized frame on its first move rather
          // than falling back to the smaller semantic/default dimensions.
          const materializedWidth = Number(root.style?.width ?? rect.width) / Math.max(0.0001, oldWorldScale)
          const materializedHeight = Number(root.style?.height ?? rect.height) / Math.max(0.0001, oldWorldScale)
          const parentNodeType = targetNode
            ? (graph.infraNodes.some(candidate => candidate.id === targetNode.id) ? 'infra' : 'system')
            : null
          return {
            nodeId: root.id, nodeType, parentNodeId: targetNode?.id ?? null, parentNodeType,
            containmentKind: parentNodeType === 'infra' ? 'hosted_by' : parentNodeType === 'system' ? 'part_of' : 'root',
            positionX: targetNode ? (nextWorld.x - targetAbsolute.x) / targetWorldScale : nextWorld.x,
            positionY: targetNode ? (nextWorld.y - targetAbsolute.y) / targetWorldScale : nextWorld.y,
            width: previous?.width ?? materializedWidth,
            height: previous?.height ?? materializedHeight,
            scale: localScaleAfterWorldFit(oldWorldScale, fit, targetNode ? targetWorldScale : 1),
          }
        })
        const changedKeys = new Set(updates.map(update => update.nodeType + ':' + update.nodeId))
        const previousLayouts = graph.floorLayouts.filter(layout => changedKeys.has(layout.nodeType + ':' + layout.nodeId))
        const optimistic = updates.map(update => ({ ...update, workspaceId, updatedAt: Date.now() }))
        useGraphStore.setState(state => ({
          floorLayouts: [...state.floorLayouts.filter(layout => !changedKeys.has(layout.nodeType + ':' + layout.nodeId)), ...optimistic],
        }))
        void apiSaveFloorLayouts(workspaceId, updates).catch(error => {
          console.error('[AxiomCanvas] floor group drop failed', error)
          useGraphStore.setState(state => ({
            floorLayouts: [...state.floorLayouts.filter(layout => !changedKeys.has(layout.nodeType + ':' + layout.nodeId)), ...previousLayouts],
          }))
        })
      }
      selectedIdsRef.current = new Set(selected)
      updateInteractiveNodes(current => current.map(candidate => ({
        ...candidate,
        selected: selected.includes(candidate.id),
        data: { ...candidate.data, isDropTarget: false, snapPreview: null, previewOffset: null },
      })))
      return
    }

    const sheetState = useSheetStore.getState()
    const sheetId = sheetState.activeSheetId
    if (sheetId) {
      const all = displayNodesRef.current
      const parentById = new Map(all.map(candidate => [candidate.id, candidate.parentId ?? null]))
      const selected = all.filter(candidate => candidate.selected && activeNodeIds.has(candidate.id)).map(candidate => candidate.id)
      if (!selected.includes(node.id)) selected.push(node.id)
      const roots = highestSelectedRoots(selected, parentById)
        .map(id => all.find(candidate => candidate.id === id))
        .filter((candidate): candidate is Node => !!candidate)
      const target = prevTarget ? all.find(candidate => candidate.id === prevTarget) : null
      const changesParent = !!target && roots.some(root => root.parentId !== target.id)
      const incomingIds = new Set(roots.map(root => root.id))
      const layoutRoots = changesParent && target
        ? [
            ...all.filter(candidate => candidate.parentId === target.id && activeNodeIds.has(candidate.id) && !incomingIds.has(candidate.id)),
            ...roots,
          ]
        : roots
      const rects = layoutRoots.map(root => {
        const absolute = getInternalNode(root.id)?.internals.positionAbsolute ?? root.position
        return { id: root.id, x: absolute.x, y: absolute.y,
          width: Number(root.measured?.width ?? root.style?.width ?? 1),
          height: Number(root.measured?.height ?? root.style?.height ?? 1) }
      })
      const targetAbsolute = target ? (getInternalNode(target.id)?.internals.positionAbsolute ?? { x: 0, y: 0 }) : { x: 0, y: 0 }
      const targetScale = target ? Number((target.data as any).worldScale ?? 1) : 1
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
      // Sheet drops follow the same reference-frame rule as the Floor: keep
      // every existing relative position, allow overlap, and fit only the
      // combined bounds when they cross the parent's content border.
      const placementRects = rects
      const group = boundsOf(placementRects)
      const incomingBounds = boundsOf(rects.filter(rect => incomingIds.has(rect.id)))
      const occupiedRects = rects.filter(rect => !incomingIds.has(rect.id))
      const incomingOffset = changesParent && target && destination && incomingBounds
        ? findUnscaledIncomingPlacement(incomingBounds, destination, occupiedRects)
        : null
      const frameTransform = changesParent && target && !incomingOffset && group && destination && incomingBounds
        ? fitReferenceFrame(group, destination, incomingBounds)
        : null
      const fit = frameTransform?.scale ?? 1
      const mutations: SheetLayoutMutation[] = []
      if (group) {
        for (const root of layoutRoots) {
          const element = sheetState.elements.find(item => (item.systemId ?? item.fileId ?? item.infraId) === root.id)
          const planned = root.id.startsWith('planned:') ? sheetState.planned.find(item => item.id === root.id.slice(8)) : undefined
          if (!element && !planned) continue
          const rect = placementRects.find(item => item.id === root.id)!
          const world = frameTransform
            ? transformReferencePoint(rect, frameTransform)
            : incomingIds.has(rect.id) && incomingOffset
              ? { x: rect.x + incomingOffset.x, y: rect.y + incomingOffset.y }
              : { x: rect.x, y: rect.y }
          const oldScale = Number((root.data as any).worldScale ?? element?.scale ?? planned?.scale ?? 1)
          mutations.push({
            kind: element ? 'element' : 'planned',
            id: element?.id ?? planned!.id,
            x: target ? (world.x - targetAbsolute.x) / targetScale : world.x,
            y: target ? (world.y - targetAbsolute.y) / targetScale : world.y,
            parentSystemId: target?.id ?? null,
            width: Number(element?.width ?? planned?.width ?? root.style?.width ?? (root.type === 'file' ? BASE_FILE_W : 620)),
            height: Number(element?.height ?? planned?.height ?? root.style?.height ?? (root.type === 'file' ? BASE_FILE_H : 420)),
            scale: localScaleAfterWorldFit(oldScale, fit, target ? targetScale : 1),
          })
        }
      }
      if (mutations.length > 0) {
        void sheetState.updateLayoutsBatch(workspaceIdForOverlay, sheetId, mutations).catch(() => {})
      }
      selectedIdsRef.current = new Set(selected)
      setSheetInteractionNodes(null)
      updateInteractiveNodes(current => current.map(candidate => ({
        ...candidate,
        selected: selected.includes(candidate.id),
        data: { ...candidate.data, isDropTarget: false, snapPreview: null, previewOffset: null },
      })))
      return
    }

  }, [currentProject, getInternalNode, getViewport, screenToFlowPosition, overlaySheetId, activeElementByNodeId, activePlannedByNodeId, activeNodeIds, workspaceIdForOverlay, updateInteractiveNodes])

  const renderedNodes = overlaySheetId
    ? displayNodes.map(n => activeNodeIds.has(n.id)
      ? {
          ...n,
          data: {
            ...n.data,
            onResizeStart: readOnly ? undefined : (params: NodeResizeParams) => {
              setIsTransitioningLayout(false)
              resizingNodeIdRef.current = n.id
              draggingNodeIdRef.current = null
              dragPositionRef.current.delete(n.id)
              const children = new Map(displayNodesRef.current
                .filter(child => child.parentId === n.id)
                .map(child => [child.id, { x: child.position.x, y: child.position.y }]))
              resizeStartRef.current.set(n.id, { ...params, children })
              armResizeEndFallback(n.id)
              setSheetInteractionNodes(current => current ?? displayNodesRef.current)
            },
            onResizeEnd: readOnly ? undefined : (params: NodeResizeParams) => onNodeResizeEnd(n.id, params),
          },
        }
      : n)
    : displayNodes

  const selectedFileIds = renderedNodes
    .filter(n => n.selected && n.type === 'file')
    .map(n => n.id)

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
      className={isTransitioningLayout ? 'layout-transition' : undefined}
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
        onNodeDragStart={readOnly ? undefined : onNodeDragStart}
        onNodeDrag={readOnly ? undefined : onNodeDrag}
        onNodeDragStop={readOnly ? undefined : onNodeDragStop}
        onMove={onMove}
        minZoom={MIN_CANVAS_ZOOM}
        maxZoom={MAX_CANVAS_ZOOM}
        defaultViewport={{ x: 0, y: 0, zoom: 0.5 }}
        fitView
        fitViewOptions={{ padding: 0.14 }}
        proOptions={{ hideAttribution: true }}
        panOnDrag={selectionMode ? [1, 2] : true}
        selectionOnDrag={readOnly ? false : selectionMode}
        selectionMode={selectionMode ? SelectionMode.Partial : SelectionMode.Full}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly && !!overlaySheetId}
        elementsSelectable={!readOnly}
        snapToGrid={false}
        // Large graphs: skip rendering off-screen nodes. Kept off for small
        // graphs where the per-move visibility recompute isn't worth it.
        onlyRenderVisibleElements={rfNodes.length > 150}
      >
        {/* Pattern color transparent — the drafting line grid is painted by
            .react-flow__background CSS; this component just provides the element. */}
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="transparent" />
        <Controls showInteractive={false} />
        <MiniMap
          style={{ width: 160, height: 100 }}
          nodeColor={(n) => {
            const d = n.data as unknown as SystemNodeData | FileNodeData | InfraNodeData
            if ('color' in d && d.color) return d.color
            if (n.type === 'file') return '#6C757D'
            if (n.type === 'infra') return '#D4A843'
            return '#2a2e33'
          }}
          maskColor="rgba(10,13,20,0.8)"
        />
        <Panel position="top-left" style={{ display: 'flex', gap: 8, margin: '12px' }}>
          <button
            onClick={tidyFrame}
            disabled={isTidying || readOnly}
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              padding: '8px 14px',
              color: 'var(--text-primary)',
              fontSize: '13px',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: (isTidying || readOnly) ? 'not-allowed' : 'pointer',
              boxShadow: 'var(--shadow-card)',
              transition: 'border-color 0.15s ease, color 0.15s ease',
            }}
            className="tidy-layout-btn"
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
                  <circle cx="12" cy="12" r="10" stroke="rgba(255, 255, 255, 0.2)" />
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
              onClick={() => setFocusEnabled(v => !v)}
              title="Dim nodes that are off the active trace / runtime path"
              style={{
                background: focusEnabled ? 'var(--bg-raised)' : 'var(--bg-surface)',
                border: `1px solid ${focusEnabled ? 'var(--trace-color)' : 'var(--border)'}`,
                padding: '8px 14px',
                color: focusEnabled ? 'var(--trace-color)' : 'var(--text-primary)',
                fontSize: '13px',
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                cursor: 'pointer',
                boxShadow: 'var(--shadow-card)',
                transition: 'border-color 0.15s ease, color 0.15s ease',
              }}
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
        <Panel position="bottom-left" style={{ margin: '0 0 12px 48px' }}>
          <ZoomIndicator />
        </Panel>
      </ReactFlow>

      {selectedFileIds.length > 1 && (
        <div style={{
          position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 1000, background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 0, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12,
          boxShadow: 'var(--shadow-card)',
        }}>
          <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
            {selectedFileIds.length} files selected
          </span>
          <button
            onClick={() => setGroupDialogOpen(true)}
            style={{
              background: 'var(--accent)', color: '#fff', border: 'none',
              borderRadius: 0, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Group into System
          </button>
          <button
            onClick={() => setSheetDialogOpen(true)}
            title="Curate the selection onto a named sheet — a live diagram telling one story"
            style={{
              background: 'var(--bg-raised)', color: 'var(--text-primary)',
              border: '1px solid var(--border)', borderRadius: 0,
              padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >
            New Sheet
          </button>
          <button
            onClick={() => setSelectionMode(false)}
            style={{
              background: 'transparent', color: 'var(--text-secondary)',
              border: '1px solid var(--border)', borderRadius: 0,
              padding: '6px 10px', fontSize: 12, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      )}

      <GroupDialog
        isOpen={groupDialogOpen}
        onClose={() => setGroupDialogOpen(false)}
        selectedFileIds={selectedFileIds}
        onSuccess={() => {
          setRfNodes(nodes => nodes.map(n => ({ ...n, selected: false })))
          useGraphStore.getState().setSelectionMode(false)
        }}
      />

      {/* Sheet layer active: stencil palette + slim indicator */}
      {overlaySheetId && (
        <>
          <SheetPalette />
          <div style={{
            position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
            zIndex: 1000, background: 'var(--bg-surface)', border: '1px solid var(--border)',
            padding: '5px 12px', boxShadow: 'var(--shadow-card)',
            fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700,
            letterSpacing: '0.08em', color: 'var(--accent)',
          }}>
            SHEET LAYER ACTIVE
          </div>
        </>
      )}

      <NewSheetDialog
        isOpen={sheetDialogOpen}
        onClose={() => setSheetDialogOpen(false)}
        selectedFileIds={selectedFileIds}
        onSuccess={() => {
          setRfNodes(nodes => nodes.map(n => ({ ...n, selected: false })))
          useGraphStore.getState().setSelectionMode(false)
        }}
      />

      {infraPickerNodeId && activePlannedByNodeId.get(`planned:${infraPickerNodeId}`) && (
        <InfraPickerDialog
          node={activePlannedByNodeId.get(`planned:${infraPickerNodeId}`)!}
          onClose={() => setInfraPickerNode(null)}
        />
      )}

    </div>
  )
}
