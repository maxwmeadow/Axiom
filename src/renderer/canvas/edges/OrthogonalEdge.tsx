import React from 'react'
import { EdgeText, type EdgeProps, getSmoothStepPath } from '@xyflow/react'

/**
 * Hard-corner stepped edge that respects the actual source and target faces.
 * Static diagram edges and transient living flows share the path primitive,
 * while living flows add their one-shot travelling pulse.
 */
export function OrthogonalEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  data,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
}: EdgeProps) {
  const [pathD, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 0,
    offset: 18,
  })

  const isTraced = !!(data as any)?.isTraced
  const isSliced = !!(data as any)?.sliced
  const isLiving = !!(data as any)?.living
  const livingColor = String((data as any)?.color ?? style?.stroke ?? '#8b6fb3')
  const livingDelayMs = Number((data as any)?.delayMs ?? 0)
  const livingTravelMs = Number((data as any)?.travelMs ?? 1550)
  const stroke = isLiving
    ? livingColor
    : isSliced
      ? '#a855f7'
      : isTraced
        ? 'var(--trace-color)'
        : 'var(--border)'

  return (
    <>
      <path
        id={id}
        d={pathD}
        pathLength={isLiving ? 1 : undefined}
        className="react-flow__edge-path"
        fill="none"
        strokeWidth={isLiving ? 2.5 : isTraced || isSliced ? 2 : 1}
        strokeDasharray={isLiving ? '0.13 0.87' : isTraced ? '8 4' : undefined}
        style={{
          ...style,
          stroke,
          animation: isLiving
            ? `axiomLivingFlowTravel ${livingTravelMs}ms cubic-bezier(0.22, 1, 0.36, 1) both`
            : isTraced ? 'traceFlow 0.6s linear infinite' : undefined,
          animationDelay: isLiving ? `${livingDelayMs}ms` : undefined,
          filter: isLiving
            ? `drop-shadow(0 0 5px ${livingColor})`
            : isTraced ? 'drop-shadow(0 0 4px var(--trace-color))' : undefined,
          transition: 'stroke 0.2s ease, stroke-width 0.2s ease',
        }}
      />
      <path
        d={pathD}
        className="react-flow__edge-interaction"
        fill="none"
        stroke="transparent"
        strokeWidth={12}
        style={{ cursor: 'pointer' }}
      />
      {label != null && (
        <EdgeText
          x={labelX}
          y={labelY}
          label={label}
          labelStyle={labelStyle}
          labelShowBg={labelShowBg}
          labelBgStyle={labelBgStyle}
          labelBgPadding={labelBgPadding}
          labelBgBorderRadius={labelBgBorderRadius}
        />
      )}
    </>
  )
}
