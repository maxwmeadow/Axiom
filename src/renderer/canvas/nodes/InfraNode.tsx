import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { InfraNodeData } from '../AxiomCanvas'
import { useInfraService } from '../../store/registryStore'
import { brandIcon, CATEGORY_GLYPHS } from './infraIcons'

// Infra node — Category x Provider x Service (INFRA_LAYER_PLAN.md).
// The CATEGORY drives the glyph and the legend label ("DATABASE · SQL"),
// the SERVICE's brand drives the icon and accent color, and STATUS renders
// proposals ghosted (dashed, dimmed) until confirmed. Drafting-table styling:
// monochrome single-path brand icons tinted with the brand accent, hairline
// borders, no glows.

// Short provider tag fallback when a brand icon is unavailable.
function providerTag(provider: string): string {
  return (provider || 'EXT').replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase()
}

export function InfraNode({ data, selected }: NodeProps) {
  const d = data as unknown as InfraNodeData
  const svc = useInfraService(d.service)

  const accent = svc?.brand.darkColor ?? svc?.brand.color ?? 'var(--infra-accent)'
  const icon = svc ? brandIcon(svc.brand.icon) : null
  const glyph = CATEGORY_GLYPHS[d.category] ?? CATEGORY_GLYPHS.api
  const proposed = d.status === 'proposed'
  const legend = [d.category?.toUpperCase(), d.subtype?.toUpperCase()].filter(Boolean).join(' · ')

  return (
    <div style={{
      width: '100%',
      height: '100%',
      background: 'var(--bg-surface)',
      border: `1px ${proposed ? 'dashed' : 'solid'} ${selected ? accent : 'var(--border)'}`,
      borderLeft: `3px ${proposed ? 'dashed' : 'solid'} ${accent}`,
      opacity: proposed ? 0.65 : 1,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      gap: 4,
      padding: '6px 10px',
      cursor: 'pointer',
      position: 'relative',
      transition: 'border-color 0.15s ease, opacity 0.15s ease',
      boxShadow: selected
        ? `var(--shadow-card), 0 0 0 1px ${accent}`
        : 'var(--shadow-card)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {icon ? (
          <svg viewBox="0 0 24 24" width={14} height={14} style={{ flexShrink: 0 }} aria-label={icon.title}>
            <path d={icon.path} fill={accent} />
          </svg>
        ) : (
          <span style={{
            fontSize: 8,
            fontWeight: 700,
            fontFamily: 'var(--font-mono)',
            color: accent,
            border: `1px solid ${accent}`,
            padding: '2px 4px',
            lineHeight: 1,
            flexShrink: 0,
          }}>{providerTag(d.provider)}</span>
        )}
        <span style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-primary)',
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}>
          {d.name}
        </span>
      </div>

      {/* Category legend strip — the drafting-table "what kind of thing is this" line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <svg viewBox="0 0 24 24" width={9} height={9} style={{ flexShrink: 0, opacity: 0.75 }}>
          <path d={glyph} fill="var(--text-dim)" />
        </svg>
        <span style={{
          fontSize: 7.5,
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: 'var(--text-dim)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {legend || 'EXTERNAL'}
        </span>
        {proposed && (
          <span style={{
            fontSize: 7.5,
            fontFamily: 'var(--font-mono)',
            fontWeight: 700,
            letterSpacing: '0.08em',
            color: 'var(--warn)',
            border: '1px dashed var(--warn)',
            padding: '1px 3px',
            lineHeight: 1,
            flexShrink: 0,
            marginLeft: 'auto',
          }}>PROPOSED</span>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top}    style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right}  style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Left}   style={{ opacity: 0 }} />
    </div>
  )
}
