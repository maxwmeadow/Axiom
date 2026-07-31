import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { InfraNodeData } from '../sceneTypes'
import { useInfraService } from '../../store/registryStore'
import { brandIcon, CATEGORY_GLYPHS, officialServiceIcon } from './infraIcons'
import { EditableNodeTitle } from './EditableNodeTitle'
import { ShapeBackdrop } from './NodeShell'
import { fitPresentationScale } from '../resizeGeometry'
import { connectionHandleProps } from './connectionChrome'
import { AxiomNodeResizer } from './AxiomNodeResizer'

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

export function InfraNode({ data, selected, width, height, isConnectable }: NodeProps) {
  const d = data as unknown as InfraNodeData
  const svc = useInfraService(d.service)
  const presentationScale = fitPresentationScale(width, height, 260, 160, d.worldScale ?? 1)

  if (!svc) return <div style={{
    width: '100%', height: '100%', position: 'relative', userSelect: 'none', cursor: 'grab',
  }}>
    <AxiomNodeResizer nodeId={d.id} presentationScale={presentationScale} nodeWidth={width} nodeHeight={height} isVisible={selected}
      isResizable={typeof d.onResizeStart === 'function' && typeof d.onResizeEnd === 'function'}
      minWidth={1} minHeight={1} color="var(--accent)"
      onResizeStart={d.onResizeStart} onResizeEnd={d.onResizeEnd} />
    <div style={{
      width: `${100 / presentationScale}%`, height: `${100 / presentationScale}%`,
      transform: `scale(${presentationScale})`, transformOrigin: 'top left', position: 'relative',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 9, padding: '12px 28px',
    }}>
      <ShapeBackdrop stock="blueprint" shape="hexagon" stroke="var(--infra-border)" strokeWidth={1} fill="var(--infra-surface)" />
      <EditableNodeTitle value={d.name} onRename={d.onRename} style={{
        color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
        textAlign: 'center', maxWidth: '78%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }} />
      {d.onChooseInfra && <button className="nodrag nopan" type="button" onPointerDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); d.onChooseInfra?.() }} style={{
          border: '1px solid var(--accent)', color: 'var(--accent)', background: 'var(--bg-raised)',
          padding: '5px 9px', fontSize: 9, fontWeight: 700, cursor: 'pointer',
        }}>Choose infrastructure</button>}
    </div>
    <Handle type="source" position={Position.Right} {...connectionHandleProps(isConnectable, presentationScale)} />
    <Handle type="target" position={Position.Left} {...connectionHandleProps(isConnectable, presentationScale)} />
  </div>

  const accent = svc?.brand.darkColor ?? svc?.brand.color ?? 'var(--infra-accent)'
  const officialIcon = svc ? officialServiceIcon(svc.id) : undefined
  const icon = svc ? brandIcon(svc.brand.icon) : null
  const glyph = CATEGORY_GLYPHS[d.category] ?? CATEGORY_GLYPHS.api
  const proposed = d.status === 'proposed'
  const shape = d.category === 'database' ? 'cylinder' as const : d.category === 'queue' ? 'hexagon' as const : 'box' as const
  const legend = [d.category?.toUpperCase(), d.subtype?.toUpperCase()].filter(Boolean).join(' · ')

  return (
    <div style={{
      width: '100%',
      height: '100%',
      position: 'relative',
      cursor: 'grab',
      userSelect: 'none',
    }}>
      <AxiomNodeResizer nodeId={d.id} presentationScale={presentationScale} nodeWidth={width} nodeHeight={height} isVisible={selected}
        isResizable={typeof d.onResizeStart === 'function' && typeof d.onResizeEnd === 'function'}
        minWidth={1} minHeight={1} color={accent}
        onResizeStart={d.onResizeStart} onResizeEnd={d.onResizeEnd} />
      <div style={{
      width: `${100 / presentationScale}%`,
      height: `${100 / presentationScale}%`,
      transform: `scale(${presentationScale})`,
      transformOrigin: 'top left',
      background: 'transparent',
      border: 'none',
      opacity: proposed ? 0.65 : 1,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      gap: 4,
      padding: shape === 'cylinder' ? '13px 12px 11px' : shape === 'hexagon' ? '7px 17px' : '6px 10px',
      position: 'relative',
      transition: 'border-color 0.15s ease, opacity 0.15s ease',
      boxShadow: 'none',
    }}>
      <ShapeBackdrop stock="blueprint" shape={shape} stroke="var(--infra-border)" strokeWidth={1} dashed={proposed} fill="var(--infra-surface)" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {officialIcon ? (
          <img src={officialIcon} width={14} height={14} alt="" style={{ flexShrink: 0 }} />
        ) : icon ? (
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
        <EditableNodeTitle value={d.name} onRename={d.onRename} style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-primary)',
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }} />
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

      </div>

      <Handle type="source" position={Position.Bottom} {...connectionHandleProps(isConnectable, presentationScale)} />
      <Handle type="target" position={Position.Top}    {...connectionHandleProps(isConnectable, presentationScale)} />
      <Handle type="source" position={Position.Right}  {...connectionHandleProps(isConnectable, presentationScale)} />
      <Handle type="target" position={Position.Left}   {...connectionHandleProps(isConnectable, presentationScale)} />
    </div>
  )
}
