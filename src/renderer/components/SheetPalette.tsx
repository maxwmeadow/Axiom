// SheetPalette — the UML stencil sidebar, shown when a sheet layer is active.
// Drag a stencil onto the canvas to place it; the new element opens straight
// into its inline name editor. Small semantic shape set by design.
import React from 'react'

export interface StencilDef {
  id: string
  label: string
  kind: 'system' | 'class' | 'file' | 'service' | 'data_store' | 'infra'
  shape: 'box' | 'folder' | 'cylinder' | 'hexagon' | 'note'
  hint: string
}

export const STENCILS: StencilDef[] = [
  { id: 'class',   label: 'Class',      kind: 'class',  shape: 'box',      hint: 'Compartment box — functions/methods inside' },
  { id: 'file',    label: 'File',       kind: 'file',   shape: 'box',      hint: 'A source file to be created' },
  { id: 'system',  label: 'System',     kind: 'system', shape: 'folder',   hint: 'Package/module grouping' },
  { id: 'service', label: 'Service',    kind: 'service', shape: 'hexagon',  hint: 'Service / API surface' },
  { id: 'infra',   label: 'Infra',      kind: 'infra',   shape: 'box',      hint: 'Choose hosting, database, queue, API, or another provider service' },
  { id: 'note',    label: 'Note',       kind: 'class',  shape: 'note',     hint: 'Free-floating annotation' },
]

function StencilGlyph({ shape }: { shape: StencilDef['shape'] }) {
  const stroke = 'var(--text-secondary)'
  const common = { fill: 'none', stroke, strokeWidth: 1.4, strokeDasharray: '4 3' }
  switch (shape) {
    case 'folder':
      return <svg width="26" height="20" viewBox="0 0 26 20"><path d="M1 5h9l2 0v0h13v14H1V5zM1 5V2h8v3" {...common} /></svg>
    case 'cylinder':
      return <svg width="26" height="20" viewBox="0 0 26 20"><ellipse cx="13" cy="4" rx="11" ry="3" {...common} /><path d="M2 4v12c0 1.7 4.9 3 11 3s11-1.3 11-3V4" {...common} /></svg>
    case 'hexagon':
      return <svg width="26" height="20" viewBox="0 0 26 20"><path d="M7 1h12l6 9-6 9H7L1 10z" {...common} /></svg>
    case 'note':
      return <svg width="26" height="20" viewBox="0 0 26 20"><path d="M1 1h18l6 6v12H1V1zM19 1v6h6" {...common} /></svg>
    default:
      return <svg width="26" height="20" viewBox="0 0 26 20"><rect x="1" y="1" width="24" height="18" {...common} /><path d="M1 8h24" {...common} /></svg>
  }
}

export function SheetPalette() {
  return (
    <div style={{
      position: 'absolute', top: 60, left: 12, zIndex: 1000,
      width: 92,
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-card)',
      padding: '8px 0 4px',
    }}>
      <div style={{
        fontSize: 8, fontFamily: 'var(--font-mono)', fontWeight: 700,
        letterSpacing: '0.1em', color: 'var(--text-dim)', padding: '0 10px 6px',
      }}>STENCILS</div>
      {STENCILS.map(s => (
        <div
          key={s.id}
          title={`${s.hint} — drag onto the canvas`}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/axiom-stencil', JSON.stringify(s))
            e.dataTransfer.effectAllowed = 'copy'
          }}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            padding: '7px 4px', cursor: 'grab', userSelect: 'none',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-raised)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <StencilGlyph shape={s.shape} />
          <span style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{s.label}</span>
        </div>
      ))}
      <div style={{
        fontSize: 8, color: 'var(--text-dim)', padding: '6px 8px 2px',
        borderTop: '1px solid var(--border-dim)', lineHeight: 1.5,
      }}>
        drag to place · type name · double-click fields to edit
      </div>
    </div>
  )
}
