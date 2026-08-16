/**
 * useSemanticZoom - Semantic zoom opacity model for the Axiom canvas.
 *
 * Instead of swapping discrete layer sets, every node has a semanticDepth
 * (0 = top-level system, 1 = subsystem/module, 2 = file, 3 = symbol).
 * Opacity and background visibility are computed from current zoom level
 * and each node's depth, creating a smooth, continuous reveal as you zoom in.
 */

import { useViewport } from '@xyflow/react'
import { useMemo } from 'react'
import type { Layer } from '../../../shared/types'
import { LAYER_ORDER, LAYER_ZOOM_THRESHOLDS } from '../../../shared/types'

// ─── Zoom thresholds per semantic depth ────────────────────────────────────
//
//  depth 0 (service/system): always visible, background ghosts at 0.35
//  depth 1 (module/dir):     fades in at 0.25, background ghosts at 0.65
//  depth 2 (file):           fades in at 0.55, always solid when visible
//  depth 3 (symbol):         fades in at 1.30, always solid when visible
//
//  The FADE_RANGE is how many zoom units the transition takes (wider = smoother)

// ─── Zoom thresholds per semantic depth ────────────────────────────────────
//
//  depth 0 (service/system): always visible, background ghosts at 0.35
//  depth 1 (module/dir):     visible at 0.22, background ghosts at 0.65
//  depth 2 (file):           visible at 0.48, always solid when visible
//  depth 3 (symbol):         visible at 1.15, always solid when visible

/**
 * Compute if a node at a given depth is visible at the current zoom level.
 */
export function isNodeVisible(depth: number, zoom: number): boolean {
  if (depth === 0) return true
  if (depth === 1) return zoom >= 0.45
  if (depth === 2) return zoom >= 0.90
  if (depth === 3) return zoom >= 1.35
  return true
}

/**
 * Compute if a container at a given depth is ghosted at the current zoom level.
 */
export function isContainerGhosted(depth: number, zoom: number): boolean {
  if (depth === 0) return zoom >= 0.70
  if (depth === 1) return zoom >= 1.15
  return false
}

// Deprecated continuous helpers kept as wrappers for fallback compatibility,
// but returning clean binary 1 or 0 for instant sharp rendering.
export function computeNodeOpacity(depth: number, zoom: number): number {
  return isNodeVisible(depth, zoom) ? 1 : 0
}

export function computeContainerBgOpacity(depth: number, zoom: number): number {
  return isContainerGhosted(depth, zoom) ? 0.05 : 1
}

export function computeContainerBorderOpacity(depth: number, zoom: number): number {
  return isContainerGhosted(depth, zoom) ? 0.3 : 0.8
}

/** Returns a CSS style object for a node at the given depth and zoom */
export function getNodeStyleForZoom(depth: number, zoom: number, isContainer: boolean): React.CSSProperties {
  const visible = isNodeVisible(depth, zoom)
  return {
    opacity: visible ? 1 : 0,
    filter: visible ? 'blur(0px)' : 'blur(6px)',
    pointerEvents: visible ? 'all' : 'none',
    transition: 'opacity 0.22s cubic-bezier(0.4, 0, 0.2, 1), filter 0.22s cubic-bezier(0.4, 0, 0.2, 1)',
  }
}

// ─── React hooks ──────────────────────────────────────────────────────────

export function getZoomTier(zoom: number): number {
  if (zoom < 0.45) return 0
  if (zoom < 0.70) return 1
  if (zoom < 0.90) return 2
  if (zoom < 1.15) return 3
  if (zoom < 1.35) return 4
  return 5
}

/** Current semantic zoom level (for status bar label) */
export function useCurrentDepth(): number {
  const { zoom } = useViewport()
  if (zoom >= 1.35) return 3
  if (zoom >= 0.90) return 2
  if (zoom >= 0.45) return 1
  return 0
}

/** Current layer name (for backwards compatibility with StatusBar) */
export function useCurrentLayer(): Layer {
  const { zoom } = useViewport()
  for (const layer of LAYER_ORDER) {
    const [min, max] = LAYER_ZOOM_THRESHOLDS[layer]
    if (zoom >= min && zoom < max) return layer
  }
  return 'SYMBOL'
}

/** Current viewport zoom - triggers re-render on any zoom change */
export function useZoom(): number {
  const { zoom } = useViewport()
  return zoom
}
