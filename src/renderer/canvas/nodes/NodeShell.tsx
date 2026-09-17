// NodeShell - the unified shape shell every canvas node converges on
// (UML_UX_PLAN.md Revision 2b: node = Shell × Body × Status).
//
// Geometry is drawn as an inline SVG path INSIDE the node's bounding box:
// - never CSS clip-path: it clips badges/tooltips (overflow) and hijacks
//   clicks in the transparent corners
// - never chrome outside the bbox: grid-drop offsets and resize math assume
//   the DOM rect IS the node
// The body renders above the SVG with shape-aware padding so content clears
// the cylinder caps / hexagon points / folder tab.
import React, { useLayoutEffect, useRef, useState } from 'react'

export type ShellShape = 'box' | 'classbox' | 'folder' | 'cylinder' | 'hexagon' | 'note'

export interface NodeShellProps {
  shape: ShellShape
  accent: string          // stroke/accent color
  dashed?: boolean        // planned/proposed vs real
  selected?: boolean
  fill?: string           // defaults to the raised surface
  children: React.ReactNode
  minWidth?: number
  maxWidth?: number
  width?: number
  height?: number
}

// Shape metrics: how much the body must inset so content clears the geometry.
const INSETS: Record<ShellShape, { top: number; right: number; bottom: number; left: number }> = {
  box:      { top: 0,  right: 0,  bottom: 0,  left: 0 },
  classbox: { top: 0,  right: 0,  bottom: 0,  left: 0 },
  folder:   { top: 13, right: 0,  bottom: 0,  left: 0 },   // tab band inside the bbox
  cylinder: { top: 12, right: 0,  bottom: 10, left: 0 },   // ellipse caps
  hexagon:  { top: 0,  right: 14, bottom: 0,  left: 14 },  // side points
  note:     { top: 0,  right: 0,  bottom: 0,  left: 0 },   // dog-ear lives in a corner
}

function shellPath(shape: ShellShape, w: number, h: number): string {
  switch (shape) {
    case 'classbox': {
      // The class silhouette: chamfered top corners - the compartment box
      // with its "corners cut", distinct at a glance from a plain file card.
      const c = 11
      return `M ${c} 1 L ${w - c} 1 L ${w - 1} ${c} L ${w - 1} ${h - 1} L 1 ${h - 1} L 1 ${c} Z`
    }
    case 'folder': {
      const tabW = Math.min(86, w * 0.42)
      const tabH = 13
      return `M 1 ${tabH} L 1 1.5 L ${tabW} 1.5 L ${tabW + 8} ${tabH} L ${w - 1} ${tabH} L ${w - 1} ${h - 1} L 1 ${h - 1} Z`
    }
    case 'cylinder': {
      const ry = 10
      return `M 1 ${ry + 1} A ${w / 2 - 1} ${ry} 0 0 1 ${w - 1} ${ry + 1} ` +
             `L ${w - 1} ${h - ry - 1} A ${w / 2 - 1} ${ry} 0 0 1 1 ${h - ry - 1} Z`
    }
    case 'hexagon': {
      const p = 14
      return `M ${p} 1 L ${w - p} 1 L ${w - 1} ${h / 2} L ${w - p} ${h - 1} L ${p} ${h - 1} L 1 ${h / 2} Z`
    }
    case 'note': {
      const ear = 14
      return `M 1 1 L ${w - ear} 1 L ${w - 1} ${ear} L ${w - 1} ${h - 1} L 1 ${h - 1} Z ` +
             `M ${w - ear} 1 L ${w - ear} ${ear} L ${w - 1} ${ear}`
    }
    default:
      return `M 1 1 L ${w - 1} 1 L ${w - 1} ${h - 1} L 1 ${h - 1} Z`
  }
}

function cylinderRimPath(w: number): string {
  const ry = 10
  // The outer cylinder path owns the upper arc. Draw the lower half of the
  // top ellipse separately so fill winding/closure can never hide the rim.
  return `M 1 ${ry + 1} A ${w / 2 - 1} ${ry} 0 0 0 ${w - 1} ${ry + 1}`
}

// ShapeBackdrop - the fluid variant for nodes whose size is owned by the
// layout engine (file cards in the grid): absolutely fills the parent and
// draws the shell path behind existing content. Parent must be
// position:relative with its own background suppressed.
// Chrome spec (design consult, 2026-07): one drop-shadow for every card
// shape; accent/heat expressed as a PERIMETER stroke color shift (quiet =
// hairline, hot/selected = full accent), never an asymmetric bar glued to
// one edge - the silhouette IS the highlight surface.
// Hard warm-gray offset shadow - a card pinned to the parchment board, never
// a soft black glow (which muddies on a light surface). Mirrors the mockup's
// `3px 3px 0` material pass.
export const CARD_SHADOW = 'drop-shadow(3px 3px 0 rgba(86,91,85,0.38))'

export function ShapeBackdrop({
  shape, stroke, strokeWidth = 1, dashed, fill = 'var(--bg-surface)',
  stock = 'paper', headBand, headBandOpacity = 1, width, height,
}: {
  shape: ShellShape
  stroke: string
  strokeWidth?: number
  dashed?: boolean
  fill?: string
  /** Which paper this node is made of. See PaperTexture.tsx. */
  stock?: 'paper' | 'card' | 'blueprint'
  // Optional header shelf: a darker band across the top of the card, clipped to
  // the silhouette so it follows chamfers/tab cuts (the mockup's leaf-head).
  // Height is in the card's base-pixel coordinate space; 0/undefined = none.
  headBand?: number
  headBandOpacity?: number
  width?: number
  height?: number
}) {
  const clipId = React.useId()
  const ref = useRef<SVGSVGElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const rimRef = useRef<SVGPathElement>(null)
  const clipRef = useRef<SVGPathElement>(null)
  const textureRef = useRef<SVGPathElement>(null)

  const initialW = typeof width === 'number' && width > 0 ? width : 180
  const initialH = typeof height === 'number' && height > 0 ? height : 72

  useLayoutEffect(() => {
    const svg = ref.current
    if (!svg) return

    const update = (w: number, h: number) => {
      const validW = Number.isFinite(w) && w > 0 ? w : 1
      const validH = Number.isFinite(h) && h > 0 ? h : 1
      svg.setAttribute('viewBox', `0 0 ${validW} ${validH}`)
      pathRef.current?.setAttribute('d', shellPath(shape, validW, validH))
      clipRef.current?.setAttribute('d', shellPath(shape, validW, validH))
      textureRef.current?.setAttribute('d', shellPath(shape, validW, validH))
      rimRef.current?.setAttribute('d', cylinderRimPath(validW))
    }

    // Fast path: explicit dimensions provided by parent node (FileNode, InfraNode)
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
      update(width, height)
      return
    }

    const el = svg.parentElement
    if (!el) return

    // Fallback path: measure DOM
    const computed = getComputedStyle(el)
    update(Number.parseFloat(computed.width), Number.parseFloat(computed.height))

    const ro = new ResizeObserver(entries => {
      const entry = entries[0]
      const borderBox = Array.isArray(entry?.borderBoxSize)
        ? entry.borderBoxSize[0]
        : entry?.borderBoxSize
      update(
        borderBox?.inlineSize ?? entry?.contentRect.width ?? 1,
        borderBox?.blockSize ?? entry?.contentRect.height ?? 1,
      )
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [shape, width, height])

  return (
    <svg
      ref={ref}
      width="100%" height="100%"
      viewBox={`0 0 ${initialW} ${initialH}`}
      preserveAspectRatio="none"
      // zIndex -1: the parent's transform creates a stacking context, so this
      // sits behind the card's static content but still inside the node.
      // zIndex 0 painted the filled path OVER the content (empty-card bug).
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible', zIndex: -1 }}
    >
      <path
        ref={pathRef}
        className="axiom-shape-backdrop-path"
        d={shellPath(shape, initialW, initialH)}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={dashed ? '6 4' : undefined}
        style={{ filter: CARD_SHADOW, transition: 'stroke 0.2s ease' }}
      />
      {/* Paper stock, clipped to the silhouette by sharing the shell path, so a
          hexagon or cylinder is textured to its own edge rather than to a box.
          Sits above the fill and below the head band and content. */}
      <path
        ref={textureRef}
        className="axiom-shape-texture"
        data-stock={stock}
        d={shellPath(shape, initialW, initialH)}
        stroke="none"
        pointerEvents="none"
      />
      {headBand ? (
        <>
          <clipPath id={clipId}><path ref={clipRef} d={shellPath(shape, initialW, initialH)} /></clipPath>
          <rect x={0} y={0} width="100%" height={headBand} clipPath={`url(#${clipId})`}
            fill="var(--card-head)" opacity={headBandOpacity}
            style={{ transition: 'opacity 0.25s ease, fill 420ms ease-out' }} />
        </>
      ) : null}
      {shape === 'cylinder' && (
        <path ref={rimRef} d={cylinderRimPath(initialW)} fill="none" stroke={stroke} strokeWidth={strokeWidth}
          strokeDasharray={dashed ? '6 4' : undefined} style={{ transition: 'stroke 0.2s ease' }} />
      )}
    </svg>
  )
}

export function NodeShell({
  shape, accent, dashed, selected, fill = 'var(--bg-raised)',
  children, minWidth = 190, maxWidth = 300, width, height,
}: NodeShellProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({
    w: typeof width === 'number' && width > 0 ? width : minWidth,
    h: typeof height === 'number' && height > 0 ? height : 60,
  })

  // Track content size when width/height are not provided.
  useLayoutEffect(() => {
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
      setSize(prev => (prev.w === width && prev.h === height ? prev : { w: width, h: height }))
      return
    }
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      // getBoundingClientRect is zoom-scaled inside ReactFlow - use offset* instead
      const nextW = el.offsetWidth || r.width
      const nextH = el.offsetHeight || r.height
      setSize(prev => (prev.w === nextW && prev.h === nextH ? prev : { w: nextW, h: nextH }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [width, height])

  const inset = INSETS[shape]
  const { w, h } = size

  return (
    <div
      ref={ref}
      style={{
        position: 'relative',
        minWidth,
        maxWidth,
        overflow: 'visible',   // badges/tooltips/handles must escape the shell
        fontFamily: 'var(--font-mono)',
      }}
    >
      <svg
        width={w} height={h}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
      >
        <path
          d={shellPath(shape, w, h)}
          fill={fill}
          stroke={accent}
          strokeOpacity={selected ? 1 : 0.55}
          strokeWidth={selected ? 1.8 : 1.2}
          strokeDasharray={dashed ? '6 4' : undefined}
          style={{ filter: CARD_SHADOW, transition: 'stroke-opacity 0.2s ease' }}
        />
        {/* Paper stock, clipped to the silhouette by sharing the shell path.
            Planned elements are the only nodes that take it - see the SHEET
            STOCK block: a sheet's material marks what is PROPOSED, so live
            code must look identical whichever surface you view it on. */}
        <path
          className="axiom-shape-texture"
          data-stock="paper"
          d={shellPath(shape, w, h)}
          stroke="none"
          pointerEvents="none"
        />
        {shape === 'cylinder' && (
          <path d={cylinderRimPath(w)} fill="none" stroke={accent}
            strokeOpacity={selected ? 1 : 0.55} strokeWidth={selected ? 1.8 : 1.2}
            strokeDasharray={dashed ? '6 4' : undefined} />
        )}
        {shape === 'folder' && (
          <text x={8} y={10.5} style={{ fontSize: 6.5, letterSpacing: '0.1em', fill: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
            SYSTEM
          </text>
        )}
      </svg>
      <div style={{
        position: 'relative',
        paddingTop: inset.top,
        paddingRight: inset.right,
        paddingBottom: inset.bottom,
        paddingLeft: inset.left,
      }}>
        {children}
      </div>
    </div>
  )
}
