import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { InfraNodeData } from '../AxiomCanvas'

const INFRA_ICONS: Record<string, string> = {
  sqlite: '🗄',
  postgres: '🐘',
  redis: '⚡',
  kafka: '📨',
  s3: '🪣',
  vercel: '▲',
  railway: '🚂',
  stripe: '💳',
  custom: '🔌',
}

export function InfraNode({ data, selected }: NodeProps) {
  const d = data as unknown as InfraNodeData
  const icon = INFRA_ICONS[d.infraType] ?? INFRA_ICONS.custom

  return (
    <div style={{
      width: '100%',
      height: '100%',
      clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
      background: selected
        ? 'rgba(245,158,11,0.25)'
        : d.agentTouched
        ? 'rgba(245,158,11,0.18)'
        : 'rgba(245,158,11,0.08)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      position: 'relative',
      transition: 'background 0.15s ease',
    }}>
      {/* Inner hex border */}
      <div style={{
        position: 'absolute', inset: 3,
        clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
        border: `1.5px solid rgba(245,158,11,${selected ? 0.7 : 0.35})`,
        pointerEvents: 'none',
      }} />

      <span style={{ fontSize: 20, lineHeight: 1 }}>{icon}</span>
      <span style={{
        fontSize: 9,
        color: '#f59e0b',
        fontWeight: 700,
        marginTop: 4,
        textAlign: 'center',
        maxWidth: 64,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {d.name}
      </span>

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top}    style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right}  style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Left}   style={{ opacity: 0 }} />
    </div>
  )
}
