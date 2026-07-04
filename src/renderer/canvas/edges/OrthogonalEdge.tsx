import React from 'react'
import { type EdgeProps, getStraightPath } from '@xyflow/react'

/**
 * Orthogonal (90-degree stair-step) edge — renders a right-angled path between
 * source and target instead of a smooth bezier. Matches the classic UML/ER
 * diagram aesthetic.
 *
 * Routing: simple midpoint stair-step.
 *   - Horizontal from source anchor to midpoint X
 *   - Vertical step to target Y
 *   - Horizontal from midpoint to target anchor
 *
 * If source and target are vertically aligned (within 20px), falls back to a
 * straight vertical line.
 */
export function OrthogonalEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
  markerStart,
  selected,
  data,
}: EdgeProps) {
  const dx = Math.abs(targetX - sourceX)
  const dy = Math.abs(targetY - sourceY)

  let pathD: string

  if (dx < 20) {
    // Nearly vertical — straight line
    pathD = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`
  } else if (dy < 20) {
    // Nearly horizontal — straight line
    pathD = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`
  } else {
    // Stair-step: horizontal → vertical → horizontal
    const midX = (sourceX + targetX) / 2
    pathD = `M ${sourceX} ${sourceY} L ${midX} ${sourceY} L ${midX} ${targetY} L ${targetX} ${targetY}`
  }

  const isTraced = !!(data as any)?.isTraced
  const isSliced = !!(data as any)?.sliced

  return (
    <>
      <path
        id={id}
        d={pathD}
        fill="none"
        stroke={isSliced ? '#a855f7' : isTraced ? 'var(--trace-color)' : 'var(--border)'}
        strokeWidth={isTraced || isSliced ? 2 : 1}
        strokeDasharray={isTraced ? '8 4' : undefined}
        style={{
          ...style,
          animation: isTraced ? 'traceFlow 0.6s linear infinite' : undefined,
          filter: isTraced ? 'drop-shadow(0 0 4px var(--trace-color))' : undefined,
          transition: 'stroke 0.2s ease, stroke-width 0.2s ease',
        }}
        markerEnd={markerEnd}
        markerStart={markerStart}
      />
      {/* Invisible wider hit area for easier selection */}
      <path
        d={pathD}
        fill="none"
        stroke="transparent"
        strokeWidth={12}
        style={{ cursor: 'pointer' }}
      />
    </>
  )
}
