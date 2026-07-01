import React from 'react'
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react'
import type { SystemNodeData } from '../AxiomCanvas'

// World-space font sizes per depth — fixed, no counter-scaling.
const DEPTH_TITLE_PX = [24, 14, 10, 8]

function GridOverlay({ d }: { d: SystemNodeData }) {
  if (!d.showDebugGrid || !d.nodeW || !d.nodeH || !d.gridCellW || !d.gridGap) return null
  const containerAlpha = typeof d.childrenVisible === 'number' ? d.childrenVisible : (d.childrenVisible ? 1 : 0)
  if (d.childSystemCount > 0 && containerAlpha > 0 && !d.isDropTarget) return null

  const w = d.nodeW, h = d.nodeH
  const cw = d.gridCellW, ch = d.gridCellH!, gap = d.gridGap
  const pitch = { x: cw + gap, y: ch + gap }

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
      let fill = "rgba(255,255,255,0.02)"
      let stroke = "rgba(255,255,255,0.06)"
      let strokeDash = undefined

      if (d.isDropTarget) {
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
          fill = "rgba(16, 185, 129, 0.05)" // gorgeous semi-transparent green for free
          stroke = "rgba(16, 185, 129, 0.25)"
          strokeDash = "2,2"
        }
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
          rx={2}
        />
      )
    }
    // Vertical divider between gap and cell
    if (x > gap) {
      els.push(<line key={`v-${col}`} x1={x} y1={0} x2={x} y2={h}
        stroke="rgba(255,220,0,0.15)" strokeWidth={0.4} />)
    }
  }

  // Horizontal dividers
  for (let row = 1; ; row++) {
    const y = row * pitch.y
    if (y >= h) break
    els.push(<line key={`h-${row}`} x1={0} y1={y} x2={w} y2={y}
      stroke="rgba(255,220,0,0.15)" strokeWidth={0.4} />)
  }

  // Header line (gap = hdr height)
  els.push(<line key="hdr" x1={0} y1={gap} x2={w} y2={gap}
    stroke="rgba(0,255,255,0.3)" strokeWidth={0.6} strokeDasharray="6,4" />)

  // Snap preview overlay
  if (d.isDropTarget && d.snapPreview) {
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
        rx={4}
        style={{
          filter: "drop-shadow(0 0 4px rgba(16, 185, 129, 0.45))",
          transition: "all 0.08s ease-out"
        }}
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
      alignItems: 'flex-start',
      gap: dotPx * 0.75,
      zIndex: 20,
      overflow: 'visible',
    }}>
      <div style={{
        width: dotPx, height: dotPx,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        marginTop: titlePx * 0.1,
        boxShadow: `0 0 ${dotPx * 0.8}px ${color}`,
      }} />
      <span style={{
        fontSize: titlePx,
        fontWeight: 700,
        color: '#e2e8f0',
        letterSpacing: '-0.02em',
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
          background: `rgba(${colorRgb}, 0.18)`,
          borderRadius: badgePx,
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
          color: '#f59e0b',
          background: 'rgba(245,158,11,0.12)',
          border: '1px solid rgba(245,158,11,0.3)',
          borderRadius: 4,
          padding: `${badgePx * 0.12}px ${badgePx * 0.5}px`,
          flexShrink: 0,
          pointerEvents: 'none',
        }}>
          AI
        </span>
      )}
    </div>
  )

  // Unified render — depth-0 vs child only differs in border/bg intensity, not structure.
  const borderAlpha = isDropTarget ? 0.9
    : selected    ? 0.85
    : isChild     ? (0.25 + containerAlpha * 0.35)
    : (0.12 + containerAlpha * 0.25)

  const bgAlpha = isDropTarget ? 0.12
    : isChild ? (0.04 + containerAlpha * 0.06)
    : (0.01 + containerAlpha * 0.03)

  const boxShadow = isDropTarget
    ? `0 0 0 3px ${color}, 0 0 ${titlePx * 1.5}px rgba(${colorRgb}, 0.35)`
    : containerAlpha > 0.2
      ? (selected
        ? `0 0 0 2px ${color}, 0 0 ${titlePx * 1.5}px rgba(${colorRgb}, 0.15)`
        : `0 ${titlePx * 0.25}px ${titlePx * containerAlpha}px rgba(${colorRgb}, ${0.08 * containerAlpha})`)
      : 'none'

  return (
    <div style={{
      width: '100%', height: '100%',
      borderRadius: radius,
      border: `1.5px solid ${isDropTarget ? color : selected ? color : `rgba(${colorRgb}, ${borderAlpha})`}`,
      background: `rgba(${colorRgb}, ${bgAlpha})`,
      backdropFilter: containerAlpha > 0.3 ? 'blur(4px)' : undefined,
      boxShadow,
      transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
      filter: blur > 0.1 ? `blur(${blur}px)` : undefined,
      transformOrigin: 'center center',
      transition: 'border 0.12s, background 0.12s, box-shadow 0.15s, transform 0.22s cubic-bezier(0.25,1,0.5,1), filter 0.18s ease-out',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <NodeResizer isVisible={selected} minWidth={60} minHeight={40} color={color}
        onResizeStart={(_e, p) => onResizeStart?.(p.width, p.height)}
        onResizeEnd={(_e, p) => onResizeEnd?.(p.width, p.height)} />
      <GridOverlay d={d} />
      {header}
      {agentTouched && (
        <div style={{
          position: 'absolute', inset: -3, borderRadius: radius + 2,
          border: '2px solid var(--agent-color, #f59e0b)',
          animation: 'agentPulse 1.5s ease-out 3',
          pointerEvents: 'none',
        }} />
      )}
      {handles}
    </div>
  )
}
