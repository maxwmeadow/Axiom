import React from 'react'
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react'
import type { SystemNodeData } from '../AxiomCanvas'

// World-space font sizes per depth — fixed, no counter-scaling.
const DEPTH_TITLE_PX = [24, 14, 10, 8]

// Drop-target feedback: renders the cell grid only while a node is being
// dragged over this container (green = free, amber = displaced, red = occupied).
function GridOverlay({ d }: { d: SystemNodeData }) {
  if (!d.isDropTarget || !d.nodeW || !d.nodeH || !d.gridCellW || !d.gridGap) return null

  const w = d.nodeW, h = d.nodeH
  const cw = d.gridCellW, ch = d.gridCellH!, gap = d.gridGap

  const els: React.ReactNode[] = []

  // Draw cells
  for (let col = 0; ; col++) {
    const x = (col + 1) * gap + col * cw
    if (x >= w) break
    for (let row = 0; ; row++) {
      const y = (row + 1) * gap + row * ch
      if (y >= h) break

      const isInSnapFootprint = !!(d.snapPreview &&
        col >= d.snapPreview.col && col < d.snapPreview.col + d.snapPreview.wUnits &&
        row >= d.snapPreview.row && row < d.snapPreview.row + d.snapPreview.hUnits)

      const isOccupied = d.occupiedCells?.has(`${col}-${row}`)
      let fill: string
      let stroke: string
      let strokeDash: string | undefined

      if (isInSnapFootprint && isOccupied) {
        // Amber = occupied cell under snap footprint → will be displaced
        fill = "rgba(245, 158, 11, 0.10)"
        stroke = "rgba(245, 158, 11, 0.55)"
        strokeDash = "2,2"
      } else if (isInSnapFootprint) {
        // Bright green = free cell that will be occupied
        fill = "rgba(16, 185, 129, 0.12)"
        stroke = "rgba(16, 185, 129, 0.55)"
      } else if (isOccupied) {
        fill = "rgba(239, 68, 68, 0.01)" // faint red for occupied
        stroke = "rgba(239, 68, 68, 0.08)"
      } else {
        fill = "rgba(16, 185, 129, 0.05)" // semi-transparent green for free
        stroke = "rgba(16, 185, 129, 0.25)"
        strokeDash = "2,2"
      }

      els.push(
        <rect key={`cell-${col}-${row}`}
          x={x} y={y}
          width={Math.min(cw, w - x)}
          height={Math.min(ch, h - y)}
          fill={fill}
          stroke={stroke}
          strokeWidth={0.5}
          strokeDasharray={strokeDash}
        />
      )
    }
  }

  // Snap preview overlay
  if (d.snapPreview) {
    const { col, row, wUnits, hUnits } = d.snapPreview
    const px = (col + 1) * gap + col * cw
    const py = (row + 1) * gap + row * ch
    const pw = wUnits * cw + (wUnits - 1) * gap
    const ph = hUnits * ch + (hUnits - 1) * gap

    els.push(
      <rect key="snap-preview"
        x={px} y={py}
        width={pw}
        height={ph}
        fill="rgba(16, 185, 129, 0.15)"
        stroke="rgba(16, 185, 129, 0.8)"
        strokeWidth={1.5}
        style={{ transition: "all 0.08s ease-out" }}
      />
    )
  }

  return (
    <svg style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}
      width={w} height={h}>
      {els}
    </svg>
  )
}

export function SystemNode({ data, selected }: NodeProps) {
  const d = data as unknown as SystemNodeData
  const { color, colorRgb, name, source, fileCount, childSystemCount, agentTouched, isChild,
    childrenVisible, selfScale, selfBlur, isDropTarget, onResizeStart, onResizeEnd, depth } = d

  const containerAlpha = typeof childrenVisible === 'number' ? childrenVisible : (childrenVisible ? 1 : 0)
  const scale = typeof selfScale === 'number' ? selfScale : 1
  const blur  = typeof selfBlur === 'number' ? selfBlur : 0
  const totalCount = fileCount + childSystemCount

  // Preview offset — applied as translate so the node visually floats to its predicted post-drop
  // position without moving the React Flow logical position (handles stay at original spot).
  const previewOffset = d.previewOffset as { x: number; y: number } | null | undefined
  const translateX = previewOffset?.x ?? 0
  const translateY = previewOffset?.y ?? 0

  // All pixel values proportional to titlePx so every depth renders identically —
  // only world-space scale differs between depths.
  const depthIdx = Math.min(depth ?? 0, DEPTH_TITLE_PX.length - 1)
  const titlePx  = DEPTH_TITLE_PX[depthIdx]
  const dotPx    = titlePx * 0.55
  const badgePx  = titlePx * 0.80
  const padX     = Math.round(titlePx * 0.75)
  const padY     = Math.round(titlePx * 0.55)
  const radius   = Math.round(titlePx * 0.55)

  const handles = (
    <>
      <Handle type="source" position={Position.Right}  style={{ opacity: 0, right: -6 }} />
      <Handle type="target" position={Position.Left}   style={{ opacity: 0, left: -6 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, bottom: -6 }} />
      <Handle type="target" position={Position.Top}    style={{ opacity: 0, top: -6 }} />
    </>
  )

  const header = (
    <div style={{
      position: 'absolute',
      top: padY, left: padX, right: padX,
      display: 'flex',
      alignItems: 'center',
      gap: dotPx * 0.75,
      zIndex: 20,
      overflow: 'visible',
    }}>
      <span style={{
        fontSize: titlePx,
        fontWeight: 600,
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-primary)',
        letterSpacing: '-0.01em',
        lineHeight: 1.25,
        flex: 1,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        pointerEvents: 'none',
      }}>
        {name}
      </span>
      {totalCount > 0 && (
        <span style={{
          fontSize: badgePx,
          color,
          background: 'var(--bg-raised)',
          border: '1px solid var(--border-dim)',
          fontFamily: 'var(--font-mono)',
          padding: `${badgePx * 0.2}px ${badgePx * 0.65}px`,
          fontWeight: 700,
          flexShrink: 0,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          marginTop: (titlePx - badgePx) * 0.15,
        }}>
          {totalCount}
        </span>
      )}
      {source === 'agent' && (
        <span style={{
          fontSize: badgePx * 0.85,
          color: 'var(--agent-color)',
          background: 'var(--bg-raised)',
          border: '1px solid var(--agent-color)',
          fontFamily: 'var(--font-mono)',
          padding: `${badgePx * 0.12}px ${badgePx * 0.5}px`,
          flexShrink: 0,
          pointerEvents: 'none',
        }}>
          AI
        </span>
      )}
    </div>
  )

  // Opaque panel fill per depth — deeper nesting sits one step "higher" on the board.
  const panelBg = `var(--panel-${Math.min(depth ?? 0, 3)})`
  // Header compartment height: the layout reserves one grid gap for the header.
  const headerH = d.gridGap ?? Math.round(padY * 2 + titlePx * 1.25)

  const dimmed = !!(d as any).dimmed

  return (
    <div style={{
      width: '100%', height: '100%',
      border: `1px solid ${isDropTarget || selected ? color : 'var(--border)'}`,
      borderLeft: `3px solid ${color}`,
      background: panelBg,
      boxShadow: isDropTarget || selected ? `0 0 0 ${isDropTarget ? 2 : 1}px ${color}` : 'none',
      transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
      filter: blur > 0.1 ? `blur(${blur}px)` : undefined,
      opacity: dimmed ? 0.3 : 1,
      transformOrigin: 'center center',
      transition: 'border 0.12s, box-shadow 0.15s, transform 0.22s cubic-bezier(0.25,1,0.5,1), filter 0.18s ease-out, opacity 0.3s ease',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <NodeResizer isVisible={selected} minWidth={60} minHeight={40} color={color}
        onResizeStart={(_e, p) => onResizeStart?.(p.width, p.height)}
        onResizeEnd={(_e, p) => onResizeEnd?.(p.width, p.height)} />
      {/* Header compartment rule — UML-style name box across the full width */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        height: headerH,
        borderBottom: `1px solid var(--border-dim)`,
        pointerEvents: 'none',
        opacity: containerAlpha,
        transition: 'opacity 0.15s ease',
        zIndex: 1,
      }} />
      <GridOverlay d={d} />
      {header}
      {agentTouched && (
        <div style={{
          position: 'absolute', inset: -3,
          border: '2px solid var(--agent-color, #f59e0b)',
          animation: 'agentPulse 1.5s ease-out 3',
          pointerEvents: 'none',
        }} />
      )}
      {handles}
    </div>
  )
}
