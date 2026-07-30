import React from 'react'
import type { AgentPresence } from '../sceneTypes'

export function AgentPresenceBadge({
  presence,
  scale = 1,
}: {
  presence?: AgentPresence[]
  scale?: number
}) {
  if (!presence?.length) return null
  const primary = presence[0]
  const label = primary.agent.length > 12
    ? `${primary.agent.slice(0, 11)}…`
    : primary.agent
  const title = presence
    .map(item => `${item.agent}: ${item.goal}`)
    .join('\n')
  const fontSize = Math.max(8, 9 * scale)

  return (
    <div
      className="nodrag nopan"
      title={title}
      aria-label={`Active work: ${title}`}
      style={{
        position: 'absolute',
        top: -10 * scale,
        right: -8 * scale,
        zIndex: 40,
        height: 19 * scale,
        minWidth: 19 * scale,
        maxWidth: 150 * scale,
        padding: `0 ${6 * scale}px`,
        display: 'flex',
        alignItems: 'center',
        gap: 4 * scale,
        background: '#243e41',
        border: `${Math.max(1, scale)}px solid #6fb6b8`,
        boxShadow: `2px 2px 0 rgba(28, 45, 46, 0.28)`,
        color: '#f2f0e5',
        fontFamily: 'var(--font-mono)',
        fontSize,
        fontWeight: 700,
        letterSpacing: '0.03em',
        lineHeight: 1,
        pointerEvents: 'auto',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6 * scale,
          height: 6 * scale,
          flexShrink: 0,
          background: '#86d0c7',
          boxShadow: '0 0 0 2px rgba(134, 208, 199, 0.18)',
        }}
      />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {presence.length > 1 && (
        <span style={{ color: '#b7e2dc', flexShrink: 0 }}>+{presence.length - 1}</span>
      )}
    </div>
  )
}
