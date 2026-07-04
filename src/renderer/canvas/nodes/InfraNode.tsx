import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { InfraNodeData } from '../AxiomCanvas'

// Short mono type codes — drafting-legend style, no emoji
const INFRA_TAGS: Record<string, string> = {
  sqlite: 'SQL',
  postgres: 'PG',
  redis: 'RDS',
  kafka: 'KFK',
  s3: 'S3',
  vercel: 'VCL',
  railway: 'RWY',
  stripe: 'STR',
  custom: 'EXT',
}

export function InfraNode({ data, selected }: NodeProps) {
  const d = data as unknown as InfraNodeData
  const tag = INFRA_TAGS[d.infraType] ?? INFRA_TAGS.custom

  return (
    <div style={{
      width: '100%',
      height: '100%',
      background: 'var(--bg-surface)',
      border: `1px solid ${selected ? 'var(--infra-accent)' : 'var(--border)'}`,
      borderLeft: '3px solid var(--infra-accent)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      justifyContent: 'center',
      padding: '6px 10px',
      cursor: 'pointer',
      position: 'relative',
      transition: 'border-color 0.15s ease',
      boxShadow: selected
        ? 'var(--shadow-card), 0 0 0 1px var(--infra-accent)'
        : 'var(--shadow-card)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          fontSize: 8,
          fontWeight: 700,
          fontFamily: 'var(--font-mono)',
          color: 'var(--infra-accent)',
          border: '1px solid var(--infra-accent)',
          padding: '2px 4px',
          lineHeight: 1,
          flexShrink: 0,
        }}>{tag}</span>
        <span style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-primary)',
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 80,
        }}>
          {d.name}
        </span>
      </div>

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top}    style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right}  style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Left}   style={{ opacity: 0 }} />
    </div>
  )
}
