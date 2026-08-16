// CompartmentBody - the ONE member/symbol row renderer (Rev 2b unification).
// A planned member and a live symbol are the same row in different states:
// planned ○ → realized ✓ (green) → live ƒ/C/I/T/v. PlannedNode uses it now;
// Planned entities use FileNode directly, so the
// moment of realization changes nothing visually except the icon and color.
import React from 'react'

export type RowIcon = 'pending' | 'realized' | 'function' | 'class' | 'interface' | 'type' | 'variable'

export interface CompartmentRow {
  icon: RowIcon
  label: string
  title?: string
  onRemove?: () => void
  onClick?: () => void
}

const ICONS: Record<RowIcon, { glyph: string; color: string }> = {
  pending:   { glyph: '○', color: 'var(--text-secondary)' },
  realized:  { glyph: '✓', color: 'var(--ok)' },
  function:  { glyph: 'ƒ', color: '#22d3ee' },
  class:     { glyph: 'C', color: '#f59e0b' },
  interface: { glyph: 'I', color: '#10b981' },
  type:      { glyph: 'T', color: '#a855f7' },
  variable:  { glyph: 'v', color: 'var(--text-secondary)' },
}

export function CompartmentBody({ rows, fontSize = 10.5 }: { rows: CompartmentRow[]; fontSize?: number }) {
  return (
    <>
      {rows.map((r, i) => {
        const ic = ICONS[r.icon]
        return (
          <div
            key={i}
            title={r.title}
            onClick={r.onClick}
            style={{
              fontSize, lineHeight: 1.7, fontFamily: 'var(--font-mono)',
              color: r.icon === 'realized' ? 'var(--ok)' : 'var(--text-secondary)',
              display: 'flex', alignItems: 'baseline', gap: 5,
              cursor: r.onClick ? 'pointer' : undefined,
            }}
          >
            <span style={{ fontSize: fontSize - 2, color: ic.color, flexShrink: 0 }}>{ic.glyph}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
            {r.onRemove && (
              <button
                onClick={(e) => { e.stopPropagation(); r.onRemove!() }}
                style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 9, padding: 0 }}
              >×</button>
            )}
          </div>
        )
      })}
    </>
  )
}
