import React from 'react'
import { useGraphStore } from '../store/graphStore'

export function AgentActivityLog() {
  const agentTouchedIds = useGraphStore(s => s.agentTouchedIds)

  if (agentTouchedIds.size === 0) return null

  return (
    <div style={{
      position: 'fixed', bottom: 32, left: 12,
      zIndex: 20,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '5px 10px',
        background: 'rgba(245,158,11,0.12)',
        border: '1px solid rgba(245,158,11,0.3)',
        borderRadius: 0,
        color: 'var(--agent-color)',
        fontSize: 11, fontWeight: 600,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--agent-color)' }} />
        Agent modified · {agentTouchedIds.size} nodes
      </div>
    </div>
  )
}
