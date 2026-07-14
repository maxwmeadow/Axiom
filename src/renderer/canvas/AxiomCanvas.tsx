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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import type { DbSystem, DbFile, DbInfraNode, DbDependency } from '../../shared/types'
import { GroupDialog } from '../components/GroupDialog'
import { NewSheetDialog } from '../components/NewSheetDialog'
import { PlannedUmlNode } from './nodes/PlannedNode'
import { SheetPalette, type StencilDef } from '../components/SheetPalette'
import { useSheetStore } from '../store/sheetStore'
import { apiAssignFile, apiUpdateFileSize, apiUpdateSystem, apiSaveNodePosition } from './arcdApi'

// ─── Node type registry ────────────────────────────────────────────────────

const NODE_TYPES: NodeTypes = {
  system:  SystemNode     as any,
  file:    FileNode       as any,
  infra:   InfraNode      as any,
  planned: PlannedUmlNode as any,
}

const EDGE_TYPES = {
  orthogonal: OrthogonalEdge as any,
}

// ─── Zoom thresholds ───────────────────────────────────────────────────────
// Consistent zoom thresholds per parent node depth.
// Children are revealed when parent's zoom level exceeds these thresholds.
// Match these with depths defined in useLayerZoom.ts:
//   - depth 0 (root parent reveals depth 1 children): zoom >= 0.45
//   - depth 1 (depth 1 parent reveals depth 2 children): zoom >= 0.90
//   - depth 2 (depth 2 parent reveals depth 3 children): zoom >= 1.35
//   - depth 3+ (depth 3 parent reveals depth 4 children): zoom >= 1.80
const REVEAL_THRESHOLDS = [0.45, 0.9, 1.35, 1.8]
const FADE_RANGE_RATIO = 0.3

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

/**
 * Exact inverse of containerW/H — use in drag handlers where the input width was
 * produced by containerW(n, parentDepth) at the same depth.
 * containerW(n, d) = n*(cw+gap)+gap  →  n = (w - gap) / (cw+gap)
 */
function wUnitsExact(w: number, parentDepth: number): number {
  const { w: cw } = fileNodeSize(parentDepth)
  const gap = gridGap(parentDepth)
  return Math.max(1, Math.round((w - gap) / (cw + gap)))
}
function hUnitsExact(h: number, parentDepth: number): number {
  const { h: ch } = fileNodeSize(parentDepth)
  const gap = gridGap(parentDepth)
  return Math.max(1, Math.round((h - gap) / (ch + gap)))
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
    while (cur.parentId) {
      const p = systems.find(x => x.id === cur.parentId)
      if (!p) break
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
  const isTidy = !Array.from(existingMap.values()).some(n => n.type === 'system' && (n.position?.x !== 0 || n.position?.y !== 0))

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

    let totalArea = 0, maxItemW = 1
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
      totalArea += item.wUnits * item.hUnits
      maxItemW = Math.max(maxItemW, item.wUnits)
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
      // 2. Auto packing (row-by-row fill)
      const cols = Math.max(maxItemW, Math.round(Math.sqrt(totalArea)))
      let curCol = 0, curRow = 0, rowMaxH = 0
      for (const item of items) {
        if (curCol + item.wUnits > cols) {
          curRow += rowMaxH; curCol = 0; rowMaxH = 0
        }
        computedPositions.set(item.id, { x: cellX(curCol, d), y: cellY(curRow, d), w: item.w, h: item.h })
        if (item.type === 'system') computedSizes.set(item.id, { w: item.w, h: item.h })
        curCol += item.wUnits
        rowMaxH = Math.max(rowMaxH, item.hUnits)
      }

      const totalRows = curRow + rowMaxH
      const totalW = containerW(cols, d)
      const totalH = containerH(totalRows, d)
      computedSizes.set(systemId, { w: totalW, h: totalH })
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
  fileCount: number
  childSystemCount: number
  agentTouched: boolean
  currentZoom: number
  isChild: boolean
  childrenVisible: number  // 0–1 continuous alpha, not boolean
  selfScale?: number
  selfBlur?: number
  isDropTarget?: boolean
  onResizeStart?: (w: number, h: number) => void
  onResizeEnd?: (w: number, h: number) => void
  // Drop-target grid overlay
  nodeW?: number
  nodeH?: number
  gridCellW?: number
  gridCellH?: number
  gridGap?: number
  occupiedCells?: Set<string>
  snapPreview?: { col: number; row: number; wUnits: number; hUnits: number } | null
  previewOffset?: { x: number; y: number } | null   // pixel offset showing predicted post-drop position
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
}

// ─── Zoom visibility (continuous fade) ─────────────────────────────────────
// Instead of binary opacity, uses a smooth ramp over a zoom range:
//   t = clamp((zoom - threshold) / fadeRange, 0, 1)
//   opacity = t, scale = 0.92 + 0.08*t, blur = (1-t)*3px
// This creates a "emerge from the substrate" feel.
// Computed node-by-node top-down to allow node-specific thresholds.

function applyZoomVisibility(nodes: Node[], zoom: number): Node[] {
  // Sort nodes by depth so parent visibility is computed before children
  const sortedNodes = [...nodes].sort((a, b) => {
    const da = (a.data as any).depth ?? 0
    const db = (b.data as any).depth ?? 0
    return da - db
  })

  const childrenVisibleMap = new Map<string, number>()

  const updatedNodes = sortedNodes.map(node => {
    const depth = (node.data as any).depth ?? 0
    const parentId = node.parentId

    // Parent visibility drives child visibility
    let selfT = 1
    if (parentId) {
      selfT = childrenVisibleMap.get(parentId) ?? 0
    }

    // Children are revealed when parent's zoom level exceeds the threshold
    const threshold = REVEAL_THRESHOLDS[Math.min(depth, REVEAL_THRESHOLDS.length - 1)]
    const ramp = zoom >= threshold ? 1 : 0
    const childT = selfT * ramp

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

function buildLayout(
  systems: DbSystem[],
  files: DbFile[],
  infraNodes: DbInfraNode[],
  dependencies: DbDependency[],
  agentTouchedIds: Set<string>,
  existingNodes: Node[],
  currentZoom: number,
  droppedNodeId?: string,
  layoutOverrides?: Map<string, { x?: number; y?: number; w?: number; h?: number }>,
  draggingNodeId?: string | null,
): { rfNodes: Node[]; rfEdges: Edge[] } {

  const existingMap = new Map<string, any>()
  if (existingNodes.length > 0) {
    for (const n of existingNodes) {
      existingMap.set(n.id, n)
    }
  } else {
    for (const s of systems) {
      if (s.positionX !== 0 || s.positionY !== 0) {
        existingMap.set(s.id, {
          id: s.id,
          position: { x: s.positionX, y: s.positionY },
          style: { width: s.width ?? undefined, height: s.height ?? undefined },
        })
      }
    }
    for (const f of files) {
      if (f.positionX !== 0 || f.positionY !== 0) {
        const parentSys = f.systemId ? systems.find(sys => sys.id === f.systemId) : null
        const parentDepth = parentSys ? parentSys.depth : 0
        const fsz = fileNodeSize(parentDepth)
        existingMap.set(f.id, {
          id: f.id,
          position: { x: f.positionX, y: f.positionY },
          style: { width: fsz.w, height: fsz.h },
        })
      }
    }
    for (const inf of infraNodes) {
      if (inf.positionX !== 0 || inf.positionY !== 0) {
        existingMap.set(inf.id, {
          id: inf.id,
          position: { x: inf.positionX, y: inf.positionY },
          style: { width: 110, height: 110 },
        })
      }
    }
  }

  if (layoutOverrides) {
    for (const [id, override] of layoutOverrides.entries()) {
      const existing = existingMap.get(id)
      if (existing) {
        const updated = { ...existing }
        if (override.x !== undefined && override.y !== undefined) {
          updated.position = { x: override.x, y: override.y }
        }
        if (override.w !== undefined && override.h !== undefined) {
          updated.style = { ...updated.style, width: override.w, height: override.h }
        }
        existingMap.set(id, updated)
      }
    }
  }

  const finalPositions = runAlternateAxisLayout(systems, files, infraNodes, dependencies, existingMap)

  const rfNodes: Node[] = []

  const childrenOf = new Map<string | null, DbSystem[]>()
  for (const sys of systems) {
    const key = sys.parentId ?? null
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key)!.push(sys)
  }

  const fileCounts = new Map<string, number>()
  const filesOf = new Map<string | null, DbFile[]>()
  for (const f of files) {
    const key = f.systemId ?? null
    if (key) {
      fileCounts.set(key, (fileCounts.get(key) ?? 0) + 1)
    }
    if (!filesOf.has(key)) filesOf.set(key, [])
    filesOf.get(key)!.push(f)
  }

  function makeFileNode(
    file: DbFile,
    parentId: string | undefined,
    position: { x: number; y: number },
    w: number,
    h: number,
    depth: number,
  ): Node {
    return {
      id: file.id,
      type: 'file',
      parentId,
      position,
      style: { width: w, height: h },
      data: {
        id: file.id,
        label: file.relPath.split('/').pop() ?? file.relPath,
        relPath: file.relPath,
        language: file.language,
        lineCount: file.lineCount,
        churnScore: file.churnScore,
        // unified shape vocabulary: override wins over inference
        shape: (file.shapeOverride || file.shape || '') as FileNodeData['shape'],
        displayName: file.displayName ?? '',
        agentTouched: agentTouchedIds.has(file.id),
        depth,
        currentZoom,
        childrenVisible: 0,
        worldScale: fileNodeSize(depth - 1).w / BASE_FILE_W,
      } satisfies FileNodeData as unknown as Record<string, unknown>,
      draggable: true,
      selectable: true,
    }
  }

  function addNode(sys: DbSystem, depth: number, parentId: string | undefined, position: { x: number; y: number }, w: number, h: number) {
    const color = systemColor(depth)
    const children = childrenOf.get(sys.id) ?? []
    const fileChildren = filesOf.get(sys.id) ?? []

    // Compute occupied cells inside this system's grid (excluding the node currently being dragged)
    const occupiedCells = new Set<string>()
    const cw = fileNodeSize(depth).w
    const ch = fileNodeSize(depth).h
    const gap = gridGap(depth)

    for (const child of children) {
      if (child.id === draggingNodeId) continue
      const pos = finalPositions.get(child.id) ?? { x: 0, y: 0, w: 200, h: 120 }
      const colStart = Math.max(0, Math.floor((pos.x - gap / 2) / (cw + gap)))
      const colEnd = Math.max(colStart, Math.floor((pos.x + pos.w - gap / 2) / (cw + gap)))
      const rowStart = Math.max(0, Math.floor((pos.y - gap / 2) / (ch + gap)))
      const rowEnd = Math.max(rowStart, Math.floor((pos.y + pos.h - gap / 2) / (ch + gap)))
      for (let c = colStart; c <= colEnd; c++) {
        for (let r = rowStart; r <= rowEnd; r++) {
          occupiedCells.add(`${c}-${r}`)
        }
      }
    }

    for (const file of fileChildren) {
      if (file.id === draggingNodeId) continue
      const fsz = fileNodeSize(depth)
      const pos = finalPositions.get(file.id) ?? { x: 0, y: 0, w: fsz.w, h: fsz.h }
      const colStart = Math.max(0, Math.floor((pos.x - gap / 2) / (fsz.w + gap)))
      const colEnd = Math.max(colStart, Math.floor((pos.x + pos.w - gap / 2) / (fsz.w + gap)))
      const rowStart = Math.max(0, Math.floor((pos.y - gap / 2) / (fsz.h + gap)))
      const rowEnd = Math.max(rowStart, Math.floor((pos.y + pos.h - gap / 2) / (fsz.h + gap)))
      for (let c = colStart; c <= colEnd; c++) {
        for (let r = rowStart; r <= rowEnd; r++) {
          occupiedCells.add(`${c}-${r}`)
        }
      }
    }

    rfNodes.push({
      id: sys.id,
      type: 'system',
      parentId,
      position,
      style: { width: w, height: h },
      data: {
        id: sys.id,
        name: sys.name,
        source: sys.source,
        color,
        colorRgb: hexToRgb(color),
        description: sys.description,
        agentNotes: sys.agentNotes,
        depth,
        fileCount: fileCounts.get(sys.id) ?? 0,
        childSystemCount: children.length,
        agentTouched: agentTouchedIds.has(sys.id),
        currentZoom,
        isChild: depth > 0,
        childrenVisible: 0,
        nodeW: w,
        nodeH: h,
        gridCellW: fileNodeSize(depth).w,
        gridCellH: fileNodeSize(depth).h,
        gridGap: gridGap(depth),
        occupiedCells,
      } satisfies SystemNodeData as unknown as Record<string, unknown>,
      draggable: true,
      selectable: true,
    })

    for (const child of children) {
      const pos = finalPositions.get(child.id) ?? { x: 0, y: 0, w: 200, h: 120 }
      addNode(child, depth + 1, sys.id, { x: pos.x, y: pos.y }, pos.w, pos.h)
    }

    for (const file of fileChildren) {
      const fsz = fileNodeSize(depth)
      const pos = finalPositions.get(file.id) ?? { x: 0, y: 0, w: fsz.w, h: fsz.h }
      rfNodes.push(makeFileNode(file, sys.id, { x: pos.x, y: pos.y }, pos.w, pos.h, depth + 1))
    }
  }

  const topSystems = childrenOf.get(null) ?? []
  for (const sys of topSystems) {
    const pos = finalPositions.get(sys.id) ?? { x: 0, y: 0, w: 400, h: 300 }
    addNode(sys, 0, undefined, { x: pos.x, y: pos.y }, pos.w, pos.h)
  }

  infraNodes.forEach((infra) => {
    const pos = finalPositions.get(infra.id) ?? { x: 0, y: 0, w: 110, h: 110 }
    rfNodes.push({
      id: infra.id,
      type: 'infra',
      position: { x: pos.x, y: pos.y },
      style: { width: pos.w, height: pos.h },
      data: {
        id: infra.id,
        label: infra.name,
        name: infra.name,
        infraType: infra.infraType,
        category: infra.category ?? 'api',
        provider: infra.provider ?? 'generic',
        service: infra.service ?? '',
        subtype: infra.subtype ?? '',
        status: infra.status ?? 'confirmed',
        agentTouched: agentTouchedIds.has(infra.id),
      } satisfies InfraNodeData as unknown as Record<string, unknown>,
      draggable: true,
      selectable: true,
    })
  })

  // Render root-level files
  const topFiles = filesOf.get(null) ?? []
  for (const file of topFiles) {
    const fsz = fileNodeSize(0)
    const pos = finalPositions.get(file.id) ?? { x: 0, y: 0, w: fsz.w, h: fsz.h }
    rfNodes.push(makeFileNode(file, undefined, { x: pos.x, y: pos.y }, pos.w, pos.h, 0))
  }

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
    systems, files, infraNodes, dependencies,
    selectedNodeId, agentTouchedIds, selectionMode, activeTrace, runtimeNodes, dataFlow,
  } = useGraphStore(useShallow(s => ({
    systems:         s.systems,
    files:           s.files,
    infraNodes:      s.infraNodes,
    dependencies:    s.dependencies,
    selectedNodeId:  s.selectedNodeId,
    agentTouchedIds: s.agentTouchedIds,
    selectionMode:   s.selectionMode,
    activeTrace:     s.activeTrace,
    runtimeNodes:    s.runtimeNodes,
    dataFlow:        s.dataFlow,
  })))

  const { setSelectedNode, setSelectionMode } = useGraphStore(
    useShallow(s => ({ setSelectedNode: s.setSelectedNode, setSelectionMode: s.setSelectionMode }))
  )
  const currentProject = useGraphStore(s => s.currentProject)
  const { fitView, getViewport, setViewport, getInternalNode, screenToFlowPosition } = useReactFlow()

  const [rfNodes, setRfNodes] = useState<Node[]>([])
  const [rfEdges, setRfEdges] = useState<Edge[]>([])
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [sheetDialogOpen, setSheetDialogOpen] = useState(false)
  // ── Sheet overlay (REVISION 2: sheets are layers over the Floor) ─────────
  // The live canvas is the base layer. When a sheet is active: dim non-member
  // live nodes in place (stencil highlight), draw planned UML elements and
  // planned edges on top. Live members keep their Floor positions.
  const overlaySheetId = useSheetStore(s => s.activeSheetId)
  const overlayElements = useSheetStore(s => s.elements)
  const overlayPlanned = useSheetStore(s => s.planned)
  const overlayPlannedEdges = useSheetStore(s => s.plannedEdges)
  const workspaceIdForOverlay = useGraphStore(s => s.currentProject?.id ?? '')

  const overlayMemberIds = useMemo(() => {
    const ids = new Set<string>()
    for (const e of overlayElements) {
      if (e.systemId) ids.add(e.systemId)
      if (e.fileId) ids.add(e.fileId)
      if (e.infraId) ids.add(e.infraId)
    }
    return ids
  }, [overlayElements])

  const displayNodes = useMemo(() => {
    if (!overlaySheetId) return rfNodes
    const dimmed = rfNodes.map(n => {
      const isMember = overlayMemberIds.has(n.id) ||
        (n.parentId ? overlayMemberIds.has(n.parentId) : false)
      if (isMember) return n
      const prevOpacity = typeof n.style?.opacity === 'number' ? n.style.opacity : 1
      return { ...n, style: { ...n.style, opacity: Math.min(prevOpacity, 0.18) }, selectable: false }
    })
    const plannedNodes: Node[] = overlayPlanned
      .filter(p => p.status !== 'flattened')
      .map(p => ({
        id: `planned:${p.id}`,
        type: 'planned',
        position: { x: p.positionX, y: p.positionY },
        data: { planned: p } as unknown as Record<string, unknown>,
        draggable: true,
        zIndex: 10000,
      }))
    return [...dimmed, ...plannedNodes]
  }, [rfNodes, overlaySheetId, overlayMemberIds, overlayPlanned])

  const displayEdges = useMemo(() => {
    if (!overlaySheetId) return rfEdges
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
    return [...rfEdges, ...plannedRf]
  }, [rfEdges, overlaySheetId, overlayPlannedEdges])

  // Stencil drop: palette → canvas → planned element born in name-edit mode.
  const onOverlayDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/axiom-stencil')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])
  const onOverlayDrop = useCallback((e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/axiom-stencil')
    if (!raw || !overlaySheetId) return
    e.preventDefault()
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
    })
  }, [overlaySheetId, workspaceIdForOverlay, screenToFlowPosition])

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
  const [debugState, setDebugState] = useState<any>(null)
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
      setTimeout(() => fitView({ padding: 0.12, duration: 400 }), 100)
    } catch (err) {
      console.error('[AxiomCanvas] Tidy layout failed', err)
    } finally {
      setIsTidying(false)
    }
  }, [systems, files, infraNodes, dependencies, currentProject, fitView])

  // Trigger tidy automatically on first-load when all coordinates are (0,0)
  useEffect(() => {
    if (systems.length === 0 && infraNodes.length === 0) return
    const projectId = currentProject?.id ?? 'demo'
    if (layoutBuiltRef.current !== projectId) {
      const allZero = systems.every(s => s.positionX === 0 && s.positionY === 0)
      if (allZero && !readOnly) {
        tidyCanvas()
      }
    }
  }, [systems, files, currentProject, readOnly, tidyCanvas])

  const currentZoomRef    = useRef(0.5)
  const zoomRafRef        = useRef<number | null>(null)
  const layoutBuiltRef = useRef<string | null>(null)
  const heldKeysRef       = useRef<Set<string>>(new Set())
  const wasdRafRef        = useRef<number | null>(null)
  const resizeStartRef    = useRef<Map<string, { w: number; h: number }>>(new Map())
  const rfNodesRef        = useRef<Node[]>([])
  const dropTargetRef     = useRef<string | null>(null)
  const draggingNodeIdRef = useRef<string | null>(null)
  const dragGrabRef       = useRef<{ offsetX: number; offsetY: number; startW: number; startH: number } | null>(null)
  const lastTargetWRef    = useRef<number | null>(null)
  const lastTargetHRef    = useRef<number | null>(null)
  const activeSnapPreviewRef = useRef<{ id: string | null; col: number; row: number } | null>(null)
  const justDroppedRef    = useRef<string | null>(null)
  const resistanceRef     = useRef<{
    holdLocalX: number; holdLocalY: number  // node's local position at the crossing point
    startCX: number;    startCY: number     // canvas cursor position at the crossing point
  } | null>(null)
  const layoutOverridesRef = useRef<Map<string, { x?: number; y?: number; w?: number; h?: number }>>(new Map())
  const targetZoomRef      = useRef<number | null>(null)
  const targetViewportRef  = useRef<{ x: number; y: number } | null>(null)
  const smoothZoomRafRef   = useRef<number | null>(null)
  const smoothZoomMouseRef = useRef<{ mx: number; my: number } | null>(null)

  rfNodesRef.current = rfNodes

  // ── Node resize ──────────────────────────────────────────────────────────
  const onNodeResizeEnd = useCallback((nodeId: string, newW: number, newH: number) => {
    const start = resizeStartRef.current.get(nodeId)
    resizeStartRef.current.delete(nodeId)
    if (!start) return
    if (Math.abs(newW - start.w) < 0.001 && Math.abs(newH - start.h) < 0.001) return

    // Find parent system depth to snap size correctly
    const node = rfNodesRef.current.find(n => n.id === nodeId)
    if (!node) return

    const parentId = node.parentId
    const parentNode = parentId ? rfNodesRef.current.find(n => n.id === parentId) : null
    const depth = parentNode ? ((parentNode.data as any).depth ?? 0) : 0

    // Snap to grid dimensions at this depth
    const wUnits = wUnitsFor(newW, depth)
    const hUnits = hUnitsFor(newH, depth)
    const snappedW = containerW(wUnits, depth)
    const snappedH = containerH(hUnits, depth)

    // Set the resized node's size in overrides
    layoutOverridesRef.current.set(nodeId, { w: snappedW, h: snappedH })

    // Update the size in rfNodes for immediate feedback
    setRfNodes(curr => curr.map(n => {
      if (n.id === nodeId) {
        return {
          ...n,
          style: { ...n.style, width: snappedW, height: snappedH },
        }
      }
      return n
    }))

    // Persist the new size — systems go to DB; files go to DB via the size endpoint
    const store = useGraphStore.getState()
    const sys = store.systems.find(s => s.id === nodeId)
    if (sys) {
      const updated = { ...sys, width: snappedW, height: snappedH }
      apiUpdateSystem(updated)
      useGraphStore.setState(s => ({
        systems: s.systems.map(s2 => s2.id === nodeId ? updated : s2),
      }))
    } else {
      const f = store.files.find(file => file.id === nodeId)
      if (f) {
        apiUpdateFileSize(nodeId, snappedW, snappedH, useGraphStore.getState().currentProject?.id ?? '')
        useGraphStore.setState(s => ({
          files: s.files.map(file => file.id === nodeId ? { ...file, width: snappedW, height: snappedH } : file),
        }))
      }
    }
  }, [])

  useEffect(() => {
    if (systems.length === 0 && infraNodes.length === 0) return

    const projectId = currentProject?.id ?? 'demo'
    // On first layout for a project, don't use existing positions — force fresh grid layout.
    // On subsequent data updates (same project), preserve user-dragged positions.
    const isFirstLayout = layoutBuiltRef.current !== projectId
    const existingNodes = isFirstLayout ? [] : rfNodes

    const { rfNodes: layout, rfEdges: newEdges } = buildLayout(
      systems, files, infraNodes, dependencies,
      agentTouchedIds, existingNodes, currentZoomRef.current,
      justDroppedRef.current ?? undefined,
      layoutOverridesRef.current,
      draggingNodeIdRef.current,
    )

    // Clear layout overrides now that they have been integrated into the layout
    layoutOverridesRef.current.clear()

    // Debug logging
    console.log(`[AxiomCanvas] Layout: ${layout.length} nodes`)
    layout.forEach(n => console.log(`  Name: ${(n.data as any).name || (n.data as any).label}, ID: ${n.id}, Parent: ${n.parentId || 'NULL'}, pos: (${Math.round(n.position.x)}, ${Math.round(n.position.y)}) size: (${Math.round(parseFloat(String(n.style?.width ?? 0)))}, ${Math.round(parseFloat(String(n.style?.height ?? 0)))})`))

    const layoutWithCallbacks = layout.map(n => ({
      ...n,
      data: {
        ...n.data,
        onResizeStart: readOnly ? undefined : (w: number, h: number) => { resizeStartRef.current.set(n.id, { w, h }) },
        onResizeEnd:   readOnly ? undefined : (w: number, h: number) => onNodeResizeEnd(n.id, w, h),
      },
    }))
    const withZoom = applyZoomVisibility(layoutWithCallbacks, currentZoomRef.current)
    const fixed = withZoom
    const dropId = justDroppedRef.current
    if (dropId) {
      // Reveal dropped node AND every ancestor so it's never hidden by a low-opacity parent
      const nodeMap = new Map(fixed.map(n => [n.id, n]))
      const toReveal = new Set<string>([dropId])
      let cur = nodeMap.get(dropId)
      while (cur?.parentId) { toReveal.add(cur.parentId); cur = nodeMap.get(cur.parentId) }
      setRfNodes(fixed.map(n => toReveal.has(n.id) ? makeFullyVisible(n) : n))

      // Save the final position of the dropped node to the database
      const droppedNode = fixed.find(n => n.id === dropId)
      if (droppedNode && currentProject) {
        const ntype = droppedNode.type === 'file' ? 'file' : 'system'
        apiSaveNodePosition(droppedNode.id, droppedNode.position.x, droppedNode.position.y, currentProject.id, ntype)
      }
    } else {
      setRfNodes(fixed)
    }
    setRfEdges(newEdges)
    // Signal overlay effects (runtime / focus / trace) to restamp their
    // per-node flags, which this full rebuild just discarded.
    setLayoutVersion(v => v + 1)

    if (isFirstLayout) {
      layoutBuiltRef.current = projectId
      setTimeout(() => fitView({ padding: 0.12, duration: 400 }), 80)
    }
  }, [systems, files, infraNodes, dependencies, selectionMode, onNodeResizeEnd])

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
    return () => {
      if (smoothZoomRafRef.current !== null) {
        cancelAnimationFrame(smoothZoomRafRef.current)
      }
    }
  }, [])

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    // Check if target or any ancestor is marked "nowheel"
    let target = e.target as HTMLElement | null
    while (target) {
      if (target.classList?.contains('nowheel')) return
      target = target.parentElement
    }

    e.preventDefault()

    const currentViewport = getViewport()
    const rect = e.currentTarget.getBoundingClientRect()
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
      targetZoomRef.current = Math.min(20, targetZoomRef.current * factor)
    } else {
      targetZoomRef.current = Math.max(0.02, targetZoomRef.current / factor)
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

  const onMove: OnMove = useCallback((event, viewport) => {
    const zoom = viewport.zoom
    currentZoomRef.current = zoom

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
      // Planned overlay nodes live in the sheet store, not rfNodes — route
      // their drags there and keep the rest on the normal path.
      const plannedChanges = changes.filter(c => 'id' in c && typeof (c as any).id === 'string' && (c as any).id.startsWith('planned:'))
      for (const ch of plannedChanges) {
        if (ch.type === 'position' && ch.position && ch.dragging === false) {
          useSheetStore.getState().movePlanned(
            useGraphStore.getState().currentProject?.id ?? '',
            (ch as any).id.slice(8), ch.position.x, ch.position.y)
        }
        if (ch.type === 'position' && ch.position) {
          // live-update during drag so the box follows the cursor
          useSheetStore.setState(s => ({
            planned: s.planned.map(p => `planned:${p.id}` === (ch as any).id
              ? { ...p, positionX: ch.position!.x, positionY: ch.position!.y } : p),
          }))
        }
      }
      const rest = changes.filter(c => !plannedChanges.includes(c))
      if (rest.length > 0) setRfNodes(ns => applyNodeChanges(rest, ns))
    }, []
  )
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setRfEdges(es => applyEdgeChanges(changes, es)), []
  )

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node.id)
  }, [setSelectedNode])

  const onPaneClick = useCallback(() => {
    setSelectedNode(null)
  }, [setSelectedNode])

  // ── Drag visibility override ─────────────────────────────────────────────
  const onNodeDragStart: OnNodeDrag = useCallback((event, node) => {
    draggingNodeIdRef.current = node.id
    setRfNodes(curr => curr.map(n => n.id === node.id ? makeFullyVisible(n) : n))
    setDebugState({ event: 'start', id: node.id, time: new Date().toLocaleTimeString() })

    const clientX = 'clientX' in event ? event.clientX : (event as any).touches?.[0]?.clientX ?? 0
    const clientY = 'clientY' in event ? event.clientY : (event as any).touches?.[0]?.clientY ?? 0
    const { x: cx, y: cy } = screenToFlowPosition({ x: clientX, y: clientY })

    // Find the correct absolute position of the node relative to flow space
    const all = rfNodesRef.current
    const parentId = node.parentId
    const parentNode = parentId ? all.find(n => n.id === parentId) : null
    const parentAbs = parentNode ? (getInternalNode(parentNode.id)?.internals.positionAbsolute ?? { x: 0, y: 0 }) : { x: 0, y: 0 }
    const absX = parentAbs.x + node.position.x
    const absY = parentAbs.y + node.position.y

    const originalDepth = (node.data as any).depth ?? 0
    const parentDepthAtStart = Math.max(0, originalDepth - 1)

    const startW = parseFloat(String(node.style?.width ?? (node.type === 'file' ? fileNodeSize(parentDepthAtStart).w : containerW(1, parentDepthAtStart))))
    const startH = parseFloat(String(node.style?.height ?? (node.type === 'file' ? fileNodeSize(parentDepthAtStart).h : containerH(1, parentDepthAtStart))))

    const offsetX = cx - absX
    const offsetY = cy - absY

    dragGrabRef.current = { offsetX, offsetY, startW, startH }
  }, [getInternalNode, screenToFlowPosition])

  // ── Drag highlight + barrier resistance ──────────────────────────────────
  // RESISTANCE_PX: screen pixels the cursor must push past a boundary before the
  // node pops through. Measured in screen space so it's zoom-independent.
  const RESISTANCE_PX = 52

  const onNodeDrag: OnNodeDrag = useCallback((event, node) => {
    const clientX = 'clientX' in event ? event.clientX : event.touches[0]?.clientX ?? 0
    const clientY = 'clientY' in event ? event.clientY : event.touches[0]?.clientY ?? 0

    // Use actual cursor position in flow space for hit-testing.
    // Do NOT use getInternalNode(node.id).positionAbsolute — we override the
    // dragged node's position during resistance, which causes positionAbsolute to
    // reflect the held position rather than the true cursor, breaking the distance check.
    const { x: cx, y: cy } = screenToFlowPosition({ x: clientX, y: clientY })

    const all = rfNodesRef.current

    // Find the innermost system the cursor is currently over (excluding self + descendants)
    const candidate = all
      .filter(n => {
        if (n.type !== 'system' || n.id === node.id) return false
        let p: Node | undefined = n
        while (p?.parentId) {
          if (p.parentId === node.id) return false
          p = all.find(x => x.id === p!.parentId)
        }
        const internal = getInternalNode(n.id)
        if (!internal) return false
        const a = internal.internals.positionAbsolute
        const w = parseFloat(String(n.style?.width ?? 0))
        const h = parseFloat(String(n.style?.height ?? 0))
        return cx >= a.x && cx <= a.x + w && cy >= a.y && cy <= a.y + h
      })
      .sort((a, b) => ((b.data as any).depth ?? 0) - ((a.data as any).depth ?? 0))[0] ?? null

    const wouldReassign = (candidate?.id ?? null) !== (node.parentId ?? null)

    // ── Resistance ────────────────────────────────────────────────────────
    // Distance is in SCREEN pixels (clientX/Y) so overriding node position
    // doesn't feed back into the measurement and cause an infinite hold.
    // Curve: cubic ease-in — node barely creeps at first, then snaps free.
    const r = resistanceRef.current
    if (r) {
      if (!wouldReassign) {
        resistanceRef.current = null  // cursor returned to home zone, cancel
      } else {
        const sdx = clientX - r.startCX
        const sdy = clientY - r.startCY
        const dist = Math.hypot(sdx, sdy)
        if (dist < RESISTANCE_PX) {
          const t     = dist / RESISTANCE_PX
          const eased = t * t * t                        // cubic ease-in
          const zoom  = currentZoomRef.current || 1
          setRfNodes(curr => curr.map(n =>
            n.id === node.id
              ? { ...n, position: { x: r.holdLocalX + (sdx / zoom) * eased,
                                    y: r.holdLocalY + (sdy / zoom) * eased } }
              : n
          ))
          return  // suppress highlight updates during resistance
        }
        resistanceRef.current = null  // popped through
      }
    }

    // ── Highlight + Snapping Preview ──────────────────────────────────────
    let snapPreview: { col: number; row: number; wUnits: number; hUnits: number } | null = null
    const newId = candidate?.id ?? null

    const originalDepth = (node.data as any).depth ?? 0
    const parentDepthAtStart = Math.max(0, originalDepth - 1)
    const sz = {
      w: parseFloat(String(node.style?.width ?? (node.type === 'file' ? fileNodeSize(parentDepthAtStart).w : containerW(1, parentDepthAtStart)))),
      h: parseFloat(String(node.style?.height ?? (node.type === 'file' ? fileNodeSize(parentDepthAtStart).h : containerH(1, parentDepthAtStart))))
    }
    const wUnits = node.type === 'file' ? 1 : wUnitsExact(sz.w, parentDepthAtStart)
    const hUnits = node.type === 'file' ? 1 : hUnitsExact(sz.h, parentDepthAtStart)

    // Determine target size and depth details for the dragged node in real time
    let targetW = node.style?.width
    let targetH = node.style?.height
    let childDepth = originalDepth
    let scale = (node.data as any).worldScale ?? 1

    if (candidate) {
      const parentDepth = (candidate.data as any).depth ?? 0
      const parentAbs = getInternalNode(candidate.id)?.internals.positionAbsolute ?? { x: 0, y: 0 }
      const localCursorX = cx - parentAbs.x
      const localCursorY = cy - parentAbs.y

      const cw = fileNodeSize(parentDepth).w
      const ch = fileNodeSize(parentDepth).h
      const gap = gridGap(parentDepth)

      const col = Math.max(0, Math.round((localCursorX - gap) / (cw + gap)))
      const row = Math.max(0, Math.round((localCursorY - gap) / (ch + gap)))

      const occupiedCells = (candidate.data as any).occupiedCells as Set<string> | undefined

      let fits = true
      for (let c = col; c < col + wUnits; c++) {
        for (let r = row; r < row + hUnits; r++) {
          if (occupiedCells?.has(`${c}-${r}`)) {
            fits = false
            break
          }
        }
        if (!fits) break
      }

      let foundCol = col
      let foundRow = row

      if (node.type === 'file') {
        if (!fits) {
          let found = false
          // Spiral search up to radius 12
          for (let r_limit = 1; r_limit <= 12; r_limit++) {
            for (let dx = -r_limit; dx <= r_limit; dx++) {
              for (let dy = -r_limit; dy <= r_limit; dy++) {
                if (Math.abs(dx) !== r_limit && Math.abs(dy) !== r_limit) continue
                const c = col + dx
                const r = row + dy
                if (c < 0 || r < 0) continue

                let possible = true
                for (let cc = c; cc < c + wUnits; cc++) {
                  for (let rr = r; rr < r + hUnits; rr++) {
                    if (occupiedCells?.has(`${cc}-${rr}`)) {
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
      } else {
        // System node: always snap directly to cursor!
        foundCol = col
        foundRow = row
      }

      snapPreview = { col: foundCol, row: foundRow, wUnits, hUnits }

      childDepth = parentDepth + 1
      scale = fileNodeSize(Math.max(0, childDepth - 1)).w / BASE_FILE_W
      if (node.type === 'file') {
        targetW = cw
        targetH = ch
      } else {
        targetW = containerW(wUnits, parentDepth)
        targetH = containerH(hUnits, parentDepth)
      }
    } else {
      // Root canvas size snap
      childDepth = 0
      scale = 1
      if (node.type === 'file') {
        targetW = fileNodeSize(0).w
        targetH = fileNodeSize(0).h
      } else {
        targetW = containerW(wUnits, 0)
        targetH = containerH(hUnits, 0)
      }
    }

    const prevSnap = activeSnapPreviewRef.current
    const prevId = dropTargetRef.current

    // Check if the target parent container ID changed
    const targetChanged = (newId !== prevId)

    // Check if the snap cell position changed (only relevant if we are hovering over a container)
    const cellChanged = newId !== null && (
      !prevSnap || 
      prevSnap.id !== newId || 
      !snapPreview || 
      prevSnap.col !== snapPreview.col || 
      prevSnap.row !== snapPreview.row
    )

    const snapChanged = targetChanged || cellChanged

    if (!snapChanged) return // Skip state update if snap target remains the same to avoid lag

    console.error(`[AxiomCanvas] onNodeDrag - Target: ${newId} (cell: ${snapPreview ? `${snapPreview.col}-${snapPreview.row}` : 'none'}, size: ${targetW}x${targetH})`)
    setDebugState({
      event: 'drag',
      nodeId: node.id,
      hoveredSystemId: newId,
      snapCell: snapPreview ? `${snapPreview.col}-${snapPreview.row}` : 'none',
      targetSize: `${targetW}x${targetH}`,
      childDepth,
      scale,
    })

    activeSnapPreviewRef.current = snapPreview ? { id: newId, col: snapPreview.col, row: snapPreview.row } : null
    dropTargetRef.current = newId

    // Arm resistance when cursor first enters a new zone
    if (newId !== prevId && newId !== null) {
      resistanceRef.current = {
        holdLocalX: node.position.x,
        holdLocalY: node.position.y,
        startCX: clientX,
        startCY: clientY,
      }
    }

    // Compute margin offsets to center the node under the cursor
    let diffX = 0
    let diffY = 0
    let sizeChanged = false
    const grab = dragGrabRef.current
    if (grab && targetW !== undefined && targetH !== undefined) {
      const curW = typeof targetW === 'number' ? targetW : parseFloat(String(targetW))
      const curH = typeof targetH === 'number' ? targetH : parseFloat(String(targetH))
      
      // Determine if this is a size change (not the initial drag start frame)
      const isFirstFrame = lastTargetWRef.current === null
      sizeChanged = !isFirstFrame && (lastTargetWRef.current !== curW || lastTargetHRef.current !== curH)
      
      lastTargetWRef.current = curW
      lastTargetHRef.current = curH

      // Center the node under the cursor: offset = originalGrabOffset - currentHalfSize
      diffX = grab.offsetX - (curW / 2)
      diffY = grab.offsetY - (curH / 2)
    }

    // Direct DOM mutation of the React Flow node wrapper to bypass internal drag size caching
    const el = document.querySelector(`.react-flow__node[data-id="${node.id}"]`) as HTMLElement | null
    if (el) {
      if (targetW !== undefined && targetH !== undefined) {
        // Enable transition only when size actually changes (to allow instant centering on grab)
        if (sizeChanged) {
          el.style.transition = 'width 0.3s cubic-bezier(0.25, 1, 0.5, 1), height 0.3s cubic-bezier(0.25, 1, 0.5, 1), margin-left 0.3s cubic-bezier(0.25, 1, 0.5, 1), margin-top 0.3s cubic-bezier(0.25, 1, 0.5, 1)'
        } else {
          el.style.transition = 'none'
        }
        el.style.width = typeof targetW === 'number' ? `${targetW}px` : String(targetW)
        el.style.height = typeof targetH === 'number' ? `${targetH}px` : String(targetH)
        el.style.marginLeft = `${diffX}px`
        el.style.marginTop = `${diffY}px`
      }
    }

    // Sibling displacement calculation for system node dragging
    const siblingDisplacements = new Map<string, { x: number; y: number }>()
    let maxColUsed = 0
    let maxRowUsed = 0

    if (node.type !== 'file' && newId !== null && snapPreview && candidate) {
      const parentDepth = (candidate.data as any).depth ?? 0
      const cw = fileNodeSize(parentDepth).w
      const ch = fileNodeSize(parentDepth).h
      const gap = gridGap(parentDepth)

      // 1. Footprint of the dragged system
      const occupiedByPlaced = new Set<string>()
      for (let c = snapPreview.col; c < snapPreview.col + snapPreview.wUnits; c++) {
        for (let r = snapPreview.row; r < snapPreview.row + snapPreview.hUnits; r++) {
          occupiedByPlaced.add(`${c}-${r}`)
        }
      }
      maxColUsed = Math.max(maxColUsed, snapPreview.col + snapPreview.wUnits)
      maxRowUsed = Math.max(maxRowUsed, snapPreview.row + snapPreview.hUnits)

      // 2. Find all siblings in candidate
      const siblings = all
        .filter(n => n.parentId === newId && n.id !== node.id)
        // Sort top-to-bottom, left-to-right
        .sort((a, b) => {
          const ay = a.position.y, ax = a.position.x
          const by = b.position.y, bx = b.position.x
          return ay !== by ? ay - by : ax - bx
        })

      // 3. Place siblings one by one
      for (const sib of siblings) {
        const sibW = parseFloat(String(sib.style?.width ?? (sib.type === 'file' ? fileNodeSize(parentDepth).w : containerW(1, parentDepth))))
        const sibH = parseFloat(String(sib.style?.height ?? (sib.type === 'file' ? fileNodeSize(parentDepth).h : containerH(1, parentDepth))))
        const sibCol = Math.max(0, Math.round((sib.position.x - gap) / (cw + gap)))
        const sibRow = Math.max(0, Math.round((sib.position.y - gap) / (ch + gap)))
        const sibWU = sib.type === 'file' ? 1 : wUnitsExact(sibW, parentDepth)
        const sibHU = sib.type === 'file' ? 1 : hUnitsExact(sibH, parentDepth)

        // Check if overlaps with currently occupied cells
        let overlaps = false
        for (let c = sibCol; c < sibCol + sibWU; c++) {
          for (let r = sibRow; r < sibRow + sibHU; r++) {
            if (occupiedByPlaced.has(`${c}-${r}`)) {
              overlaps = true
              break
            }
          }
          if (overlaps) break
        }

        let finalCol = sibCol
        let finalRow = sibRow

        if (overlaps) {
          // Find next nearest free spot using spiral search
          let found = false
          for (let r_limit = 1; r_limit <= 20; r_limit++) {
            for (let dx = -r_limit; dx <= r_limit; dx++) {
              for (let dy = -r_limit; dy <= r_limit; dy++) {
                if (Math.abs(dx) !== r_limit && Math.abs(dy) !== r_limit) continue
                const c = sibCol + dx
                const r = sibRow + dy
                if (c < 0 || r < 0) continue

                let possible = true
                for (let cc = c; cc < c + sibWU; cc++) {
                  for (let rr = r; rr < r + sibHU; rr++) {
                    if (occupiedByPlaced.has(`${cc}-${rr}`)) {
                      possible = false;
                      break
                    }
                  }
                  if (!possible) break
                }
                if (possible) {
                  finalCol = c
                  finalRow = r
                  found = true
                  break
                }
              }
              if (found) break
            }
            if (found) break
          }
        }

        // Mark footprint as occupied
        for (let c = finalCol; c < finalCol + sibWU; c++) {
          for (let r = finalRow; r < finalRow + sibHU; r++) {
            occupiedByPlaced.add(`${c}-${r}`)
          }
        }
        maxColUsed = Math.max(maxColUsed, finalCol + sibWU)
        maxRowUsed = Math.max(maxRowUsed, finalRow + sibHU)

        // Calculate visual offset in pixels
        const dx = cellX(finalCol, parentDepth) - cellX(sibCol, parentDepth)
        const dy = cellY(finalRow, parentDepth) - cellY(sibRow, parentDepth)
        siblingDisplacements.set(sib.id, { x: dx, y: dy })
      }
    }

    setRfNodes(curr => curr.map(n => {
      let updatedNode = n
      // Resize the node being dragged in real time to target size and update its depth/scale
      if (n.id === node.id) {
        updatedNode = {
          ...n,
          style: { ...n.style, width: targetW, height: targetH },
          data: {
            ...n.data,
            depth: childDepth,
            worldScale: scale,
            previewOffset: null,
          }
        }
      }

      // If it is a displaced sibling, apply displacement previewOffset
      const disp = siblingDisplacements.get(n.id)
      if (disp) {
        updatedNode = {
          ...updatedNode,
          data: {
            ...updatedNode.data,
            previewOffset: disp,
          }
        }
      } else if (n.data && (n.data as any).previewOffset) {
        updatedNode = {
          ...updatedNode,
          data: {
            ...updatedNode.data,
            previewOffset: null,
          }
        }
      }

      // Preview target container expansion
      if (n.id === newId && node.type !== 'file' && maxColUsed > 0 && maxRowUsed > 0 && candidate) {
        const parentDepth = (candidate.data as any).depth ?? 0
        const previewW = containerW(maxColUsed, parentDepth)
        const previewH = containerH(maxRowUsed, parentDepth)
        updatedNode = {
          ...updatedNode,
          style: { ...updatedNode.style, width: previewW, height: previewH },
          data: {
            ...updatedNode.data,
            nodeW: previewW,
            nodeH: previewH,
          }
        }
      }

      // Restore container size of previous target if we hovered out
      if (n.id === prevId && prevId !== newId) {
        const orig = useGraphStore.getState().systems.find(sys => sys.id === prevId)
        const origW = orig?.width ?? containerW(1, (n.data as any).depth ?? 0)
        const origH = orig?.height ?? containerH(1, (n.data as any).depth ?? 0)
        updatedNode = {
          ...updatedNode,
          style: { ...updatedNode.style, width: origW, height: origH },
          data: {
            ...updatedNode.data,
            isDropTarget: false,
            snapPreview: null,
            selfScale: 0.97,
            nodeW: origW,
            nodeH: origH,
          }
        }
      }

      // Set preview for new target
      if (n.id === newId) {
        return { ...updatedNode, data: { ...updatedNode.data, isDropTarget: true, snapPreview, selfScale: prevId !== newId ? 1.03 : 1.0 } }
      }
      // Clear other previews
      if (n.data && (n.data as any).snapPreview && n.id !== newId) {
        return { ...updatedNode, data: { ...updatedNode.data, snapPreview: null } }
      }
      return updatedNode
    }))

    if (newId !== prevId) {
      setTimeout(() => {
        setRfNodes(curr => curr.map(n => {
          if (n.id === newId || n.id === prevId) return { ...n, data: { ...n.data, selfScale: 1.0 } }
          return n
        }))
      }, 140)
    }
  }, [getInternalNode, screenToFlowPosition])

  const onNodeDragStop: OnNodeDrag = useCallback((event, node) => {
    const displacedSiblings: { id: string; type: string; x: number; y: number }[] = []
    // Clear drag state — restore zoom visibility, clear drop highlight
    draggingNodeIdRef.current = null
    resistanceRef.current = null
    activeSnapPreviewRef.current = null
    const prevTarget = dropTargetRef.current
    dropTargetRef.current = null

    // Direct DOM cleanup of the React Flow node wrapper styles
    const el = document.querySelector(`.react-flow__node[data-id="${node.id}"]`) as HTMLElement | null
    if (el) {
      el.style.transition = ''
      el.style.marginLeft = ''
      el.style.marginTop = ''
    }
    dragGrabRef.current = null
    lastTargetWRef.current = null
    lastTargetHRef.current = null

    setRfNodes(curr => applyZoomVisibility(
      curr.map(n => {
        let updated = n.id === prevTarget ? { ...n, data: { ...n.data, isDropTarget: false, snapPreview: null } } : n
        if (updated.data && (updated.data as any).previewOffset) {
          updated = { ...updated, data: { ...updated.data, previewOffset: null } }
        }
        return updated
      }),
      currentZoomRef.current,
    ))

    // Infra nodes: just persist position, no reassignment
    if (node.type === 'infra') {
      useGraphStore.setState(s => ({
        infraNodes: s.infraNodes.map(n =>
          n.id === node.id ? { ...n, positionX: node.position.x, positionY: node.position.y } : n
        )
      }))
      return
    }

    // ── Drop detection for ALL system and file nodes ─────────────────────
    const all = rfNodesRef.current

    // Invariant wUnits and hUnits calculation based on original depth
    const originalDepth = (node.data as any).depth ?? 0
    const parentDepthAtStart = Math.max(0, originalDepth - 1)
    const sz = {
      w: parseFloat(String(node.style?.width ?? (node.type === 'file' ? fileNodeSize(parentDepthAtStart).w : containerW(1, parentDepthAtStart)))),
      h: parseFloat(String(node.style?.height ?? (node.type === 'file' ? fileNodeSize(parentDepthAtStart).h : containerH(1, parentDepthAtStart))))
    }
    const wUnits = node.type === 'file' ? 1 : wUnitsExact(sz.w, parentDepthAtStart)
    const hUnits = node.type === 'file' ? 1 : hUnitsExact(sz.h, parentDepthAtStart)

    // Calculate absolute coordinates of the dragged node
    const oldParentId = node.parentId
    const oldParentNode = oldParentId ? all.find(n => n.id === oldParentId) : null
    const oldParentAbs = oldParentNode ? (getInternalNode(oldParentNode.id)?.internals.positionAbsolute ?? { x: 0, y: 0 }) : { x: 0, y: 0 }
    const absX = oldParentAbs.x + node.position.x
    const absY = oldParentAbs.y + node.position.y

    // Use cursor position for hit-testing — this matches onNodeDrag's highlight logic exactly.
    const clientX = 'clientX' in event ? event.clientX : (event as any).touches?.[0]?.clientX ?? 0
    const clientY = 'clientY' in event ? event.clientY : (event as any).touches?.[0]?.clientY ?? 0
    const { x: cursorX, y: cursorY } = screenToFlowPosition({ x: clientX, y: clientY })

    // Find the innermost system under the cursor (excluding self and own descendants)
    const newParent = all
      .filter(n => {
        if (n.type !== 'system' || n.id === node.id) return false
        let p: Node | undefined = n
        while (p?.parentId) {
          if (p.parentId === node.id) return false
          p = all.find(x => x.id === p!.parentId)
        }
        const internal = getInternalNode(n.id)
        if (!internal) return false
        const a = internal.internals.positionAbsolute
        const w = parseFloat(String(n.style?.width ?? 0))
        const h = parseFloat(String(n.style?.height ?? 0))
        return cursorX >= a.x && cursorX <= a.x + w && cursorY >= a.y && cursorY <= a.y + h
      })
      .sort((a, b) => ((b.data as any).depth ?? 0) - ((a.data as any).depth ?? 0))[0] ?? null

    // Compute the target position (snapped to parent cells if in a container, raw if at root)
    let newPos = { x: absX, y: absY }
    if (newParent) {
      const parentDepth = (newParent.data as any).depth ?? 0
      const parentAbs = getInternalNode(newParent.id)?.internals.positionAbsolute ?? { x: 0, y: 0 }

      const cw = fileNodeSize(parentDepth).w
      const ch = fileNodeSize(parentDepth).h
      const gap = gridGap(parentDepth)

      // Use the stored snap preview cell that the user visually saw highlighted.
      // Only fall back to cursor-based calculation when the preview is stale or mismatched.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snapData = activeSnapPreviewRef.current as any as { id: string; col: number; row: number } | null
      let foundCol: number
      let foundRow: number

      if (snapData !== null && snapData.id === newParent.id) {
        // Snap exactly to what was highlighted on screen
        foundCol = snapData.col
        foundRow = snapData.row
      } else {
        // Cursor-based fallback (preview was not set, e.g. drag ended before onNodeDrag fired)
        const localCursorX = cursorX - parentAbs.x
        const localCursorY = cursorY - parentAbs.y
        const col = Math.max(0, Math.round((localCursorX - gap) / (cw + gap)))
        const row = Math.max(0, Math.round((localCursorY - gap) / (ch + gap)))

        const occupiedCells = (newParent.data as any).occupiedCells as Set<string> | undefined

        let fits = true
        for (let c = col; c < col + wUnits; c++) {
          for (let r = row; r < row + hUnits; r++) {
            if (occupiedCells?.has(`${c}-${r}`)) { fits = false; break }
          }
          if (!fits) break
        }

        foundCol = col
        foundRow = row

        if (!fits) {
          let found = false
          for (let r_limit = 1; r_limit <= 12 && !found; r_limit++) {
            for (let dx = -r_limit; dx <= r_limit && !found; dx++) {
              for (let dy = -r_limit; dy <= r_limit && !found; dy++) {
                if (Math.abs(dx) !== r_limit && Math.abs(dy) !== r_limit) continue
                const c = col + dx, r = row + dy
                if (c < 0 || r < 0) continue
                let possible = true
                for (let cc = c; cc < c + wUnits && possible; cc++)
                  for (let rr = r; rr < r + hUnits && possible; rr++)
                    if (occupiedCells?.has(`${cc}-${rr}`)) possible = false
                if (possible) { foundCol = c; foundRow = r; found = true }
              }
            }
          }
        }
      }

      newPos = {
        x: cellX(foundCol, parentDepth),
        y: cellY(foundRow, parentDepth)
      }

      // Sibling displacement resolution on drop (only if dragged node is a system node)
      if (node.type !== 'file') {
        // Use the resolved foundCol and foundRow for the dropped node
        const occupiedByPlaced = new Set<string>()
        for (let c = foundCol; c < foundCol + wUnits; c++) {
          for (let r = foundRow; r < foundRow + hUnits; r++) {
            occupiedByPlaced.add(`${c}-${r}`)
          }
        }

        // Find all siblings in newParent (excluding the dragged node itself)
        const siblings = all
          .filter(n => n.parentId === newParent.id && n.id !== node.id)
          .sort((a, b) => {
            const ay = a.position.y, ax = a.position.x
            const by = b.position.y, bx = b.position.x
            return ay !== by ? ay - by : ax - bx
          })

        for (const sib of siblings) {
          const sibW = parseFloat(String(sib.style?.width ?? (sib.type === 'file' ? fileNodeSize(parentDepth).w : containerW(1, parentDepth))))
          const sibH = parseFloat(String(sib.style?.height ?? (sib.type === 'file' ? fileNodeSize(parentDepth).h : containerH(1, parentDepth))))
          const sibCol = Math.max(0, Math.round((sib.position.x - gap) / (cw + gap)))
          const sibRow = Math.max(0, Math.round((sib.position.y - gap) / (ch + gap)))
          const sibWU = sib.type === 'file' ? 1 : wUnitsExact(sibW, parentDepth)
          const sibHU = sib.type === 'file' ? 1 : hUnitsExact(sibH, parentDepth)

          let overlaps = false
          for (let c = sibCol; c < sibCol + sibWU; c++) {
            for (let r = sibRow; r < sibRow + sibHU; r++) {
              if (occupiedByPlaced.has(`${c}-${r}`)) {
                overlaps = true
                break
              }
            }
            if (overlaps) break
          }

          let finalCol = sibCol
          let finalRow = sibRow

          if (overlaps) {
            let found = false
            for (let r_limit = 1; r_limit <= 20; r_limit++) {
              for (let dx = -r_limit; dx <= r_limit; dx++) {
                for (let dy = -r_limit; dy <= r_limit; dy++) {
                  if (Math.abs(dx) !== r_limit && Math.abs(dy) !== r_limit) continue
                  const c = sibCol + dx
                  const r = sibRow + dy
                  if (c < 0 || r < 0) continue

                  let possible = true
                  for (let cc = c; cc < c + sibWU; cc++) {
                    for (let rr = r; rr < r + sibHU; rr++) {
                      if (occupiedByPlaced.has(`${cc}-${rr}`)) {
                        possible = false
                        break
                      }
                    }
                    if (!possible) break
                  }
                  if (possible) {
                    finalCol = c
                    finalRow = r
                    found = true
                    break
                  }
                }
                if (found) break
              }
              if (found) break
            }
          }

          for (let c = finalCol; c < finalCol + sibWU; c++) {
            for (let r = finalRow; r < finalRow + sibHU; r++) {
              occupiedByPlaced.add(`${c}-${r}`)
            }
          }

          if (finalCol !== sibCol || finalRow !== sibRow) {
            displacedSiblings.push({
              id: sib.id,
              type: sib.type ?? 'system',
              x: cellX(finalCol, parentDepth),
              y: cellY(finalRow, parentDepth)
            })
          }
        }
      }
    }

    const sameParent = (newParent?.id ?? null) === (node.parentId ?? null)
    if (sameParent) {
      if (newParent) {
        if (currentProject) {
          const ntype = node.type === 'file' ? 'file' : 'system'
          apiSaveNodePosition(node.id, newPos.x, newPos.y, currentProject.id, ntype)
        }
        if (node.type === 'system') {
          useGraphStore.setState(s => ({
            systems: s.systems.map(sys =>
              sys.id === node.id ? { ...sys, positionX: newPos.x, positionY: newPos.y } : sys
            )
          }))
        } else if (node.type === 'file') {
          useGraphStore.setState(s => ({
            files: s.files.map(f =>
              f.id === node.id ? { ...f, positionX: newPos.x, positionY: newPos.y } : f
            )
          }))
        }

        // Apply database and store updates for displaced siblings
        for (const sib of displacedSiblings) {
          if (sib.type === 'file') {
            useGraphStore.setState(s => ({
              files: s.files.map(f => f.id === sib.id ? { ...f, positionX: sib.x, positionY: sib.y } : f)
            }))
            apiSaveNodePosition(sib.id, sib.x, sib.y, currentProject?.id ?? '', 'file')
          } else {
            const storedSib = useGraphStore.getState().systems.find(sys => sys.id === sib.id)
            if (storedSib) {
              const updatedSib = {
                ...storedSib,
                positionX: sib.x,
                positionY: sib.y,
              }
              useGraphStore.setState(s => ({
                systems: s.systems.map(sys => sys.id === sib.id ? updatedSib : sys)
              }))
              apiUpdateSystem(updatedSib)
            }
          }
        }

        setRfNodes(curr => curr.map(n => {
          let updated = n.id === node.id ? { ...n, position: newPos } : n

          // Clear previewOffset
          if (updated.data && (updated.data as any).previewOffset) {
            updated = { ...updated, data: { ...updated.data, previewOffset: null } }
          }

          // Apply displaced siblings position updates to rfNodes
          const disp = displacedSiblings.find(s => s.id === updated.id)
          if (disp) {
            updated = { ...updated, position: { x: disp.x, y: disp.y } }
          }
          return updated
        }))
      } else {
        if (currentProject) {
          const ntype = node.type === 'file' ? 'file' : 'system'
          apiSaveNodePosition(node.id, node.position.x, node.position.y, currentProject.id, ntype)
        }
        if (node.type === 'system') {
          useGraphStore.setState(s => ({
            systems: s.systems.map(sys =>
              sys.id === node.id ? { ...sys, positionX: node.position.x, positionY: node.position.y } : sys
            )
          }))
        } else if (node.type === 'file') {
          useGraphStore.setState(s => ({
            files: s.files.map(f =>
              f.id === node.id ? { ...f, positionX: node.position.x, positionY: node.position.y } : f
            )
          }))
        }
      }
      return
    }

    // Reassignment — keep the node visible through the layout rebuild
    justDroppedRef.current = node.id
    setTimeout(() => {
      if (justDroppedRef.current === node.id) {
        justDroppedRef.current = null
        setRfNodes(curr => applyZoomVisibility(curr, currentZoomRef.current))
      }
    }, 2500)

    const parentId = newParent?.id ?? null
    const parentDepth = newParent ? ((newParent.data as any).depth ?? 0) : 0
    const childDepth = newParent ? parentDepth + 1 : 0
    const scale = fileNodeSize(Math.max(0, childDepth - 1)).w / BASE_FILE_W
    const newW = node.type === 'file'
      ? (newParent ? fileNodeSize(parentDepth).w : fileNodeSize(0).w)
      : (newParent ? containerW(wUnits, parentDepth) : containerW(wUnits, 0))
    const newH = node.type === 'file'
      ? (newParent ? fileNodeSize(parentDepth).h : fileNodeSize(0).h)
      : (newParent ? containerH(hUnits, parentDepth) : containerH(hUnits, 0))

    layoutOverridesRef.current.set(node.id, { x: newPos.x, y: newPos.y, w: newW, h: newH })

    console.error(`[AxiomCanvas] onNodeDragStop - Node: ${node.id}, parentId: ${parentId}, newPos: (${newPos.x}, ${newPos.y}), size: ${newW}x${newH}`)
    setDebugState({
      event: 'stop',
      nodeId: node.id,
      parentId,
      newPos,
      newSize: `${newW}x${newH}`,
    })

    // Apply updates for displaced siblings in cross-parent drop
    for (const sib of displacedSiblings) {
      if (sib.type === 'file') {
        useGraphStore.setState(s => ({
          files: s.files.map(f => f.id === sib.id ? { ...f, positionX: sib.x, positionY: sib.y } : f)
        }))
        apiSaveNodePosition(sib.id, sib.x, sib.y, currentProject?.id ?? '', 'file')
      } else {
        const storedSib = useGraphStore.getState().systems.find(sys => sys.id === sib.id)
        if (storedSib) {
          const updatedSib = {
            ...storedSib,
            positionX: sib.x,
            positionY: sib.y,
          }
          useGraphStore.setState(s => ({
            systems: s.systems.map(sys => sys.id === sib.id ? updatedSib : sys)
          }))
          apiUpdateSystem(updatedSib)
        }
      }
    }

    setRfNodes(curr => curr.map(n => {
      let updatedNode = n

      // Clear previewOffset
      if (n.data && (n.data as any).previewOffset) {
        updatedNode = { ...updatedNode, data: { ...updatedNode.data, previewOffset: null } }
      }

      if (n.id === node.id) {
        updatedNode = {
          ...updatedNode,
          position: newPos,
          parentId: parentId ?? undefined,
          style: { ...updatedNode.style, width: newW, height: newH },
          data: {
            ...updatedNode.data,
            depth: childDepth,
            worldScale: scale,
          }
        }
      }

      // Apply displaced sibling positions to rfNodes
      const disp = displacedSiblings.find(s => s.id === updatedNode.id)
      if (disp) {
        updatedNode = {
          ...updatedNode,
          position: { x: disp.x, y: disp.y }
        }
      }

      return updatedNode
    }))

    if (node.type === 'file') {
      useGraphStore.setState(s => ({
        files: s.files.map(f => f.id === node.id ? { ...f, systemId: parentId, positionX: newPos.x, positionY: newPos.y, width: newW, height: newH } : f)
      }))
      apiAssignFile(node.id, parentId, currentProject?.id ?? '')
      apiUpdateFileSize(node.id, newW, newH, currentProject?.id ?? '')
      apiSaveNodePosition(node.id, newPos.x, newPos.y, currentProject?.id ?? '', 'file')

    } else if (node.type === 'system') {
      const stored = useGraphStore.getState().systems.find(s => s.id === node.id)
      if (!stored) return
      const updated = {
        ...stored,
        parentId: parentId,
        depth: childDepth,
        positionX: newPos.x,
        positionY: newPos.y,
        width: newW,
        height: newH,
      }
      useGraphStore.setState(s => ({
        systems: s.systems.map(sys => sys.id === node.id ? updated : sys)
      }))
      apiUpdateSystem(updated)
    }
  }, [currentProject, getInternalNode, screenToFlowPosition])

  const selectedFileIds = rfNodes
    .filter(n => n.selected && n.type === 'file')
    .map(n => n.id)

  return (
    <div
      onWheel={handleWheel}
      onDragOver={onOverlayDragOver}
      onDrop={onOverlayDrop}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      <ReactFlow
        zoomOnScroll={false}
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        defaultEdgeOptions={{ type: 'orthogonal' }}
        onNodesChange={readOnly ? undefined : onNodesChange}
        onEdgesChange={readOnly ? undefined : onEdgesChange}
        onConnect={readOnly ? undefined : onConnectPlanned}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onNodeDragStart={readOnly ? undefined : onNodeDragStart}
        onNodeDrag={readOnly ? undefined : onNodeDrag}
        onNodeDragStop={readOnly ? undefined : onNodeDragStop}
        onMove={onMove}
        minZoom={0.02}
        maxZoom={20}
        defaultViewport={{ x: 0, y: 0, zoom: 0.5 }}
        fitView
        fitViewOptions={{ padding: 0.14 }}
        proOptions={{ hideAttribution: true }}
        panOnDrag={selectionMode ? [1, 2] : true}
        selectionOnDrag={readOnly ? false : selectionMode}
        selectionMode={selectionMode ? SelectionMode.Partial : SelectionMode.Full}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
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
            onClick={tidyCanvas}
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

      {debugState && (
        <div style={{
          position: 'absolute',
          bottom: 24,
          right: 24,
          zIndex: 99999,
          background: 'var(--bg-surface)',
          color: '#34d399',
          padding: '12px',
          borderRadius: 0,
          fontFamily: 'monospace',
          fontSize: '11px',
          pointerEvents: 'none',
          maxHeight: '350px',
          width: '280px',
          overflow: 'auto',
          border: '1px solid rgba(52, 211, 153, 0.3)',
          boxShadow: 'var(--shadow-card)',
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '6px', borderBottom: '1px solid rgba(52, 211, 153, 0.2)', paddingBottom: '4px' }}>
            Axiom Drag Debug Overlay
          </div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(debugState, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}
