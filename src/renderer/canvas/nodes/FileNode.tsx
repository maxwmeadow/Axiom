import React from 'react'
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react'
import type { FileNodeData } from '../AxiomCanvas'

function getLangIconContent(lang: string): React.ReactNode {
  switch (lang.toLowerCase()) {
    case 'typescript':
      return <><rect width="24" height="24" rx="4" fill="#3178c6" /><text x="20" y="19" fill="#fff" fontSize="10" fontWeight="900" fontFamily="system-ui, sans-serif" textAnchor="end">TS</text></>
    case 'tsx':
      return <><rect width="24" height="24" rx="4" fill="#149eca" /><text x="20" y="19" fill="#fff" fontSize="8" fontWeight="900" fontFamily="system-ui, sans-serif" textAnchor="end">TSX</text></>
    case 'javascript':
      return <><rect width="24" height="24" rx="4" fill="#f7df1e" /><text x="20" y="19" fill="#303030" fontSize="10" fontWeight="900" fontFamily="system-ui, sans-serif" textAnchor="end">JS</text></>
    case 'jsx':
      return <><rect width="24" height="24" rx="4" fill="#e8b84b" /><text x="20" y="19" fill="#303030" fontSize="8" fontWeight="900" fontFamily="system-ui, sans-serif" textAnchor="end">JSX</text></>
    case 'python':
      return <><rect width="24" height="24" rx="4" fill="#3572a5" opacity="0.9" /><text x="12" y="15.5" fill="#ffd343" fontSize="9" fontWeight="900" fontFamily="system-ui, sans-serif" textAnchor="middle">PY</text></>
    case 'go':
      return <><rect width="24" height="24" rx="4" fill="#00add8" /><text x="12" y="15.5" fill="#fff" fontSize="9" fontWeight="900" fontFamily="system-ui, sans-serif" textAnchor="middle">GO</text></>
    case 'rust':
      return <><rect width="24" height="24" rx="4" fill="rgba(222,165,132,0.1)" stroke="#dea584" strokeWidth="1.2" /><text x="12" y="15.5" fill="#dea584" fontSize="9" fontWeight="bold" fontFamily="system-ui, sans-serif" textAnchor="middle">RS</text></>
    case 'csharp':
      return <><polygon points="12,2 22,7 22,17 12,22 2,17 2,7" fill="#178600" /><text x="12" y="15.5" fill="#fff" fontSize="9" fontWeight="900" fontFamily="system-ui, sans-serif" textAnchor="middle">C#</text></>
    default:
      return <><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="var(--text-secondary)" strokeWidth="2" /><path d="M9 17V7l7 5z" fill="none" stroke="var(--text-secondary)" strokeWidth="2" /></>
  }
}

export function FileNode({ data, selected }: NodeProps) {
  const d = data as unknown as FileNodeData
  const { onResizeStart, onResizeEnd } = d as any
  const churn = d.churnScore ?? 0
  const isTraced = !!(d as any).isTraced

  // Scale all pixel values proportionally so nodes look identical at every depth
  // when zoomed to their natural viewing level.
  const s = d.worldScale ?? 1
  const fontPx   = Math.max(8,  Math.round(12 * s))
  const statPx   = Math.max(7,  Math.round(10 * s))
  const iconSz   = Math.max(10, Math.round(14 * s))
  const padX     = Math.max(6,  Math.round(12 * s))
  const padY     = Math.max(4,  Math.round(8  * s))
  const gapRow   = Math.max(3,  Math.round(7  * s))
  const radius   = Math.max(4,  Math.round(8  * s))
  const churnColor = churn > 0.7 ? '#ef4444' : churn > 0.4 ? '#f59e0b' : 'transparent'

  // Preview offset: visually floats this node to its predicted post-drop position without
  // moving the React Flow logical position (only used when another node is being dragged nearby).
  const previewOffset = (d as any).previewOffset as { x: number; y: number } | null | undefined
  const translateX = previewOffset?.x ?? 0
  const translateY = previewOffset?.y ?? 0

  return (
    <div
      className={`glass-node ${selected ? 'glass-node-selected' : ''}`}
      style={{
        width: '100%',
        height: '100%',
        padding: `${padY}px ${padX}px ${padY}px ${padX + 2}px`,
        borderRadius: radius,
        cursor: 'pointer',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        border: `1.5px solid ${d.agentTouched ? 'var(--agent-color)' : selected ? '#3b82f6' : 'rgba(255,255,255,0.08)'}`,
        borderLeft: `3px solid ${churnColor !== 'transparent' ? churnColor : (selected ? '#3b82f6' : 'rgba(255,255,255,0.08)')}`,
        transform: `translate(${translateX}px, ${translateY}px)`,
        transition: translateX !== 0 || translateY !== 0 ? 'transform 0.22s cubic-bezier(0.25,1,0.5,1)' : undefined,
      }}
    >
      <NodeResizer isVisible={selected} minWidth={60} minHeight={30} color="#3b82f6"
        onResizeStart={(_e: any, p: any) => onResizeStart?.(p.width, p.height)}
        onResizeEnd={(_e: any, p: any) => onResizeEnd?.(p.width, p.height)} />
      {d.agentTouched && (
        <div style={{
          position: 'absolute', inset: -3,
          borderRadius: radius + 2,
          border: '1.5px solid var(--agent-color)',
          animation: 'agentPulse 1.5s ease-out 3',
          pointerEvents: 'none',
        }} />
      )}
      {isTraced && (
        <div style={{
          position: 'absolute', inset: -3,
          borderRadius: radius + 2,
          border: '2px solid var(--trace-color)',
          animation: 'tracePulse 1.2s ease-in-out infinite',
          pointerEvents: 'none',
        }} />
      )}

      {/* Filename + language icon */}
      <div style={{ display: 'flex', alignItems: 'center', gap: gapRow, minWidth: 0 }}>
        <svg viewBox="0 0 24 24" width={iconSz} height={iconSz} style={{ flexShrink: 0 }}>
          {getLangIconContent(d.language ?? 'unknown')}
        </svg>
        <span style={{
          fontSize: fontPx,
          color: 'var(--text-primary)',
          fontWeight: 600,
          letterSpacing: '-0.01em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          minWidth: 0,
        }} title={d.relPath}>
          {d.label}
        </span>
      </div>

      {/* File stats */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: Math.max(3, Math.round(6 * s)),
        fontSize: statPx,
        color: 'var(--text-secondary)',
        opacity: 0.8,
      }}>
        {d.lineCount > 0 && <span>{d.lineCount}L</span>}
        {churn > 0.4 && (
          <>
            <span style={{ opacity: 0.4 }}>·</span>
            <span style={{ color: churnColor }}>
              {churn > 0.7 ? 'hot' : 'active'}
            </span>
          </>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top}    style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right}  style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Left}   style={{ opacity: 0 }} />
    </div>
  )
}
