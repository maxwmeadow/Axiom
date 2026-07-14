import React from 'react'
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react'
import type { FileNodeData } from '../AxiomCanvas'
import type { RuntimeNodeState } from '../../store/graphStore'
import { useGraphStore } from '../../store/graphStore'
import { ShapeBackdrop } from './NodeShell'
import { siPython } from 'simple-icons'

function getLangIconContent(lang: string): React.ReactNode {
  switch (lang.toLowerCase()) {
    case 'typescript':
      return <><rect width="24" height="24" rx="2" fill="#3178c6" /><text x="20" y="19" fill="#fff" fontSize="10" fontWeight="900" fontFamily="var(--font-mono)" textAnchor="end">TS</text></>
    case 'tsx':
      return <><rect width="24" height="24" rx="2" fill="#149eca" /><text x="20" y="19" fill="#fff" fontSize="8" fontWeight="900" fontFamily="var(--font-mono)" textAnchor="end">TSX</text></>
    case 'javascript':
      return <><rect width="24" height="24" rx="2" fill="#f7df1e" /><text x="20" y="19" fill="#303030" fontSize="10" fontWeight="900" fontFamily="var(--font-mono)" textAnchor="end">JS</text></>
    case 'jsx':
      return <><rect width="24" height="24" rx="2" fill="#e8b84b" /><text x="20" y="19" fill="#303030" fontSize="8" fontWeight="900" fontFamily="var(--font-mono)" textAnchor="end">JSX</text></>
    case 'python':
      // The actual Python mark (two-snake plus), not a lettered chip.
      return <path d={siPython.path} fill="#4B8BBE" />
    case 'go':
      return <><rect width="24" height="24" rx="2" fill="#00add8" /><text x="12" y="15.5" fill="#fff" fontSize="9" fontWeight="900" fontFamily="var(--font-mono)" textAnchor="middle">GO</text></>
    case 'rust':
      return <><rect width="24" height="24" rx="2" fill="rgba(222,165,132,0.1)" stroke="#dea584" strokeWidth="1.2" /><text x="12" y="15.5" fill="#dea584" fontSize="9" fontWeight="bold" fontFamily="var(--font-mono)" textAnchor="middle">RS</text></>
    case 'csharp':
      return <><polygon points="12,2 22,7 22,17 12,22 2,17 2,7" fill="#178600" /><text x="12" y="15.5" fill="#fff" fontSize="9" fontWeight="900" fontFamily="var(--font-mono)" textAnchor="middle">C#</text></>
    default:
      return <><rect x="3" y="3" width="18" height="18" rx="1" fill="none" stroke="var(--text-secondary)" strokeWidth="2" /><path d="M9 17V7l7 5z" fill="none" stroke="var(--text-secondary)" strokeWidth="2" /></>
  }
}

type SymbolTab = 'functions' | 'variables' | 'classes'

/** Which tab a symbol kind belongs to. Unknown kinds render as 'v' rows, so they live under variables. */
function tabForKind(kind: string): SymbolTab {
  switch ((kind || '').toLowerCase()) {
    case 'function':
    case 'method':
      return 'functions'
    case 'class':
    case 'interface':
    case 'type':
      return 'classes'
    default:
      return 'variables'
  }
}

function RuntimeTooltip({ runtime, color }: { runtime: RuntimeNodeState; color: string }) {
  const Row = ({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) => (
    <div style={{ display: 'flex', gap: 6, lineHeight: 1.5 }}>
      <span style={{ color: 'var(--text-secondary)', opacity: 0.7, flexShrink: 0 }}>{label}</span>
      <span style={{
        color: valueColor ?? 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        wordBreak: 'break-all',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        display: '-webkit-box',
        WebkitLineClamp: 3,
        WebkitBoxOrient: 'vertical',
      }}>{value}</span>
    </div>
  )
  return (
    <div
      className="nodrag nopan"
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 260,
        maxWidth: 260,
        padding: '8px 10px',
        borderRadius: 0,
        background: 'var(--bg-overlay)',
        border: `1px solid ${color}`,
        boxShadow: '6px 6px 0 rgba(0,0,0,0.35)',
        zIndex: 100,
        fontSize: 11,
        pointerEvents: 'none',
        textAlign: 'left',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <strong style={{ color, fontFamily: 'var(--font-mono)' }}>{runtime.lastSymbol || runtime.watchedSymbols.join(', ')}</strong>
        <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)', opacity: 0.7 }}>{runtime.callCount}×</span>
      </div>
      {runtime.lastArgs && <Row label="args" value={runtime.lastArgs} />}
      {runtime.lastReturn && <Row label="→" value={runtime.lastReturn} valueColor="#22c55e" />}
      {runtime.lastException && <Row label="✗" value={runtime.lastException} valueColor="#ef4444" />}
      {runtime.rateLimited && (
        <div style={{ marginTop: 4, color: '#f59e0b' }}>rate-limited — watch auto-disabled</div>
      )}
    </div>
  )
}

export function FileNode({ data, selected }: NodeProps) {
  const d = data as unknown as FileNodeData
  const { onResizeStart, onResizeEnd } = d as any
  const [hovered, setHovered] = React.useState(false)
  const churn = d.churnScore ?? 0
  const isTraced = !!(d as any).isTraced
  const dimmed = !!(d as any).dimmed
  const sliced = !!(d as any).sliced
  const runtime = (d as any).runtime as RuntimeNodeState | null | undefined
  const isWatched = !!runtime && runtime.watchedSymbols.length > 0
  const isPerturbed = !!runtime?.injection
  const verdict = runtime?.verdict ?? null
  const runtimeColor = isPerturbed ? '#f97316'
    : verdict === 'fail' ? '#ef4444'
    : verdict === 'pass' ? '#22c55e'
    : runtime?.lastKind === 'exception' ? '#ef4444'
    : runtime?.rateLimited ? '#f59e0b'
    : '#22d3ee'

  // Content renders at base (depth-0) pixel sizes inside a div that is
  // 1/s times the node's box, then uniformly scaled down by s. Every file
  // node is therefore pixel-identical in its own frame at any depth.
  const s = d.worldScale ?? 1
  // Apparent zoom of this node on screen — a depth-2 node at viewport zoom 2
  // looks like a depth-0 node at zoom 0.5. Detail states gate on this.
  const effZoom = d.currentZoom * s
  const churnColor = churn > 0.7 ? '#ef4444' : churn > 0.4 ? '#f59e0b' : 'transparent'
  // Unified shape vocabulary (Rev 2b): class-first header when the file IS its
  // class; cylinder/hexagon files get a shape backdrop over the same card.
  // Class-first only fires when it ADDS information: in class-per-file
  // languages (C#, Java) className === filename for nearly every file, and a
  // chip on 90% of nodes is noise, not signal.
  const stem = (d.label.split('.')[0] ?? '').toLowerCase().replace(/[_-]/g, '')
  const classFirst = d.shape === 'class' && !!d.displayName &&
    d.displayName.toLowerCase().replace(/[_-]/g, '') !== stem
  // Shape = structure: classes wear the chamfered classbox; cylinder/hexagon
  // only via explicit override (never guessed). Plain files are 'box' — every
  // card renders through the SAME ShapeBackdrop so chrome cannot fork.
  const shellShape = d.shape === 'class' ? 'classbox' as const
    : d.shape === 'cylinder' || d.shape === 'hexagon' ? d.shape : 'box' as const
  // Perimeter stroke = accent + heat in one channel (design spec): quiet
  // hairline by default, activity heat and states shift the whole silhouette.
  const perimeter = selected ? 'var(--accent)'
    : d.agentTouched ? 'var(--agent-color)'
    : churn > 0.7 ? '#ff453a'
    : churn > 0.4 ? '#ff9f0a'
    : 'var(--border)'
  const perimeterW = selected || churn > 0.4 ? 1.6 : 1

  const previewOffset = (d as any).previewOffset as { x: number; y: number } | null | undefined
  const translateX = previewOffset?.x ?? 0
  const translateY = previewOffset?.y ?? 0

  const hasTooltip = isWatched && !!(runtime && (runtime.lastArgs || runtime.lastReturn || runtime.lastException || runtime.callCount > 0))

  // Symbols with a pending/armed injection on this file, for per-row dots
  const runtimeInjections = useGraphStore(s => s.runtimeInjections)
  const perturbedSymbols = React.useMemo(() => {
    const set = new Set<string>()
    for (const inj of Object.values(runtimeInjections)) {
      if (inj.fileId === d.id && (inj.status === 'pending_confirm' || inj.status === 'armed')) {
        set.add(inj.symbol)
      }
    }
    return set
  }, [runtimeInjections, d.id])

  // Lazy-load symbols from archd when zoom crosses 1.2
  const currentProject = useGraphStore(s => s.currentProject)
  const workspaceId = currentProject?.id ?? 'demo'
  const [symbols, setSymbols] = React.useState<any[] | null>(null)
  const [symbolsLoading, setSymbolsLoading] = React.useState(false)
  const [activeTab, setActiveTab] = React.useState<SymbolTab>('functions')

  React.useEffect(() => {
    if (effZoom >= 1.2 && !symbols && !symbolsLoading) {
      setSymbolsLoading(true)
      fetch(`http://127.0.0.1:7744/api/files/${d.id}/symbols?workspace=${encodeURIComponent(workspaceId)}`)
        .then(res => {
          if (!res.ok) throw new Error()
          return res.json()
        })
        .then(data => {
          const syms = data || []
          setSymbols(syms)
          setSymbolsLoading(false)
          // Default to the first non-empty category so class-only files
          // don't open on an empty "functions" tab.
          const first = (['functions', 'variables', 'classes'] as const).find(
            tab => syms.some((sym: any) => tabForKind(sym.kind) === tab)
          )
          if (first) setActiveTab(first)
        })
        .catch(() => {
          setSymbols([])
          setSymbolsLoading(false)
        })
    }
  }, [effZoom, d.id, workspaceId, symbols, symbolsLoading])

  const handleSymbolClick = (sym: any) => {
    const fileObj = useGraphStore.getState().files.find(f => f.id === d.id)
    if (fileObj && window.axiom) {
      window.axiom.showInFolder(fileObj.path)
    }
  }

  // Filter symbols based on the active tab
  const filteredSymbols = React.useMemo(() => {
    if (!symbols) return []

    return symbols.filter(sym => tabForKind(sym.kind) === activeTab)
  }, [symbols, activeTab])

  const renderSymbolIcon = (kind: string) => {
    switch (kind.toLowerCase()) {
      case 'function':
      case 'method':
        return <span style={{ color: '#22d3ee', marginRight: 4, fontFamily: 'var(--font-mono)' }}>ƒ</span>
      case 'class':
        return <span style={{ color: '#f59e0b', marginRight: 4, fontFamily: 'var(--font-mono)' }}>C</span>
      case 'interface':
        return <span style={{ color: '#10b981', marginRight: 4, fontFamily: 'var(--font-mono)' }}>I</span>
      case 'type':
        return <span style={{ color: '#a855f7', marginRight: 4, fontFamily: 'var(--font-mono)' }}>T</span>
      default:
        return <span style={{ color: 'var(--text-secondary)', marginRight: 4, fontFamily: 'var(--font-mono)' }}>v</span>
    }
  }

  return (
    <div
      onMouseEnter={() => hasTooltip && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        cursor: 'pointer',
        transform: `translate(${translateX}px, ${translateY}px)`,
        transition: translateX !== 0 || translateY !== 0
          ? 'transform 0.22s cubic-bezier(0.25,1,0.5,1)'
          : 'opacity 0.3s ease',
        opacity: dimmed ? 0.22 : 1,
        filter: dimmed ? 'saturate(0.5)' : undefined,
      }}
    >
      {/* Content plane: laid out at base (depth-0) size, uniformly scaled to fit
          the node box so every file node looks identical in its own frame. */}
      <div
        // ONE chrome system: the ShapeBackdrop draws surface, silhouette,
        // shadow, and state for every shape — no CSS-class fork, ever.
        style={{
          width: `${100 / s}%`,
          height: `${100 / s}%`,
          transform: `scale(${s})`,
          transformOrigin: 'top left',
          position: 'relative',
          padding: shellShape === 'hexagon' ? '6px 16px 6px 18px'
            : shellShape === 'cylinder' ? '13px 10px 12px 12px'
            : '6px 10px 6px 12px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-start',
          gap: 4,
          background: 'transparent',
        }}
      >
      <ShapeBackdrop shape={shellShape} stroke={perimeter} strokeWidth={perimeterW} />
      {/* Name compartment: icon + filename left, line count right. Rule is
          INSET (not full-bleed) so it never collides with shaped silhouettes. */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        minWidth: 0,
        flexShrink: 0,
        paddingBottom: 5,
        paddingRight: 20,   // clears the corner line-count figure
        borderBottom: '1px solid var(--border-dim)',
      }}>
        {/* Language icon ALWAYS — class-ness is expressed by the node SHAPE
            (chamfered classbox), never by hijacking the icon slot. */}
        <svg viewBox="0 0 24 24" width={14} height={14} style={{ flexShrink: 0 }}>
          {getLangIconContent(d.language ?? 'unknown')}
        </svg>
        <span style={{
          fontSize: 12,
          color: 'var(--text-primary)',
          fontWeight: 600,
          letterSpacing: '-0.01em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          minWidth: 0,
          fontFamily: 'var(--font-mono)',
        }} title={d.relPath}>
          {/* class-first: the file IS its class — class name leads; the real
              filename lives in the hover tooltip, never cramped inline. */}
          {classFirst ? d.displayName : d.label}
        </span>
      </div>
      {/* Line count — a quiet figure tucked under the corner cut, not a badge
          shouting from the header. */}
      {d.lineCount > 0 && (
        <span style={{
          position: 'absolute',
          top: shellShape === 'classbox' ? 13 : 4,
          right: 6,
          fontSize: 7.5,
          color: 'var(--text-dim)',
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em',
          pointerEvents: 'none',
        }}>{d.lineCount}</span>
      )}

      {effZoom < 1.2 ? (
        /* State 1: Compact — line count lives in the header, only churn here */
        churn > 0.4 ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            fontSize: 10,
            opacity: 0.8,
            flexShrink: 0,
          }}>
            <span style={{ color: churnColor, fontFamily: 'var(--font-mono)' }}>
              {churn > 0.7 ? 'hot' : 'active'}
            </span>
          </div>
        ) : null
      ) : (
        /* State 2 & 3: Scrollable Viewports */
        <div style={{
          display: 'flex',
          flexDirection: 'row',
          flex: 1,
          minHeight: 0,
          gap: 4,
          marginTop: 2,
        }} className="nodrag nopan nowheel">
          {/* Scrollable symbols list viewport */}
          <div
            className="symbol-scroll"
            style={{
              flex: 1,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              paddingRight: 2,
            }}
          >
            {symbolsLoading ? (
              <span style={{ fontSize: 8, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>Loading...</span>
            ) : !symbols || symbols.length === 0 ? (
              <span style={{ fontSize: 8, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>No symbols</span>
            ) : filteredSymbols.length === 0 ? (
              <span style={{ fontSize: 8, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>Empty</span>
            ) : (
              filteredSymbols.map((sym, idx) => {
                const isSymWatched = runtime?.watchedSymbols?.includes(sym.name)
                const isSymPerturbed = perturbedSymbols.has(sym.name)
                const symColor = isSymPerturbed ? '#f97316' : isSymWatched ? '#22d3ee' : 'var(--text-primary)'

                return (
                  <div
                    key={`${sym.name}-${idx}`}
                    onClick={() => handleSymbolClick(sym)}
                    className="symbol-row"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: 8,
                      fontFamily: 'var(--font-mono)',
                      color: symColor,
                      padding: '1px 2px',
                      borderRadius: 0,
                      transition: 'background 0.1s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--bg-raised)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {renderSymbolIcon(sym.kind)}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sym.name}>
                        {sym.name}
                      </span>
                    </div>
                    <span style={{ color: 'var(--text-dim)', fontSize: 7, flexShrink: 0, marginLeft: 4 }}>
                      :{sym.lineStart}
                    </span>
                  </div>
                )
              })
            )}
          </div>

          {/* Vertical tab rail, flush right */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            flexShrink: 0,
            marginLeft: 'auto',
          }}>
              {(['functions', 'variables', 'classes'] as const).map(tab => (
                <span
                  key={tab}
                  title={tab}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    setActiveTab(tab)
                  }}
                  style={{
                    width: 14,
                    height: 14,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 9,
                    fontFamily: 'var(--font-mono)',
                    cursor: 'pointer',
                    borderRadius: 0,
                    border: `1px solid ${activeTab === tab ? 'var(--accent)' : 'var(--border)'}`,
                    color: activeTab === tab ? 'var(--accent)' : 'var(--text-secondary)',
                    background: activeTab === tab ? 'var(--bg-raised)' : 'transparent',
                    fontWeight: activeTab === tab ? 700 : 400,
                  }}
                >
                  {tab === 'functions' ? 'ƒ' : tab === 'variables' ? 'v' : 'C'}
                </span>
              ))}
          </div>
        </div>
      )}

      </div>

      {/* Everything below lives on the unscaled node frame so resize handles,
          status rings, and tooltips stay legible at any depth. */}
      <NodeResizer isVisible={selected} minWidth={60} minHeight={30} color="var(--accent)"
        onResizeStart={(_e: any, p: any) => onResizeStart?.(p.width, p.height)}
        onResizeEnd={(_e: any, p: any) => onResizeEnd?.(p.width, p.height)} />
      {d.agentTouched && (
        <div style={{
          position: 'absolute', inset: -3,
          borderRadius: 0,
          border: '1.5px solid var(--agent-color)',
          animation: 'agentPulse 1.5s ease-out 3',
          pointerEvents: 'none',
        }} />
      )}
      {isTraced && (
        <div style={{
          position: 'absolute', inset: -3,
          borderRadius: 0,
          border: '2px solid var(--trace-color)',
          animation: 'tracePulse 1.2s ease-in-out infinite',
          pointerEvents: 'none',
        }} />
      )}
      {sliced && (
        <div style={{
          position: 'absolute', inset: -3,
          borderRadius: 0,
          border: '2px solid #a855f7',
          background: 'rgba(168,85,247,0.06)',
          pointerEvents: 'none',
        }} />
      )}
      {(isWatched || isPerturbed || verdict) && (
        <div style={{
          position: 'absolute', inset: -3,
          borderRadius: 0,
          border: `${isPerturbed || verdict ? 2 : 1.5}px solid ${runtimeColor}`,
          opacity: isPerturbed ? 0.95 : 0.7,
          boxShadow: isPerturbed ? `0 0 12px ${runtimeColor}66` : undefined,
          animation: runtime?.injection === 'pending_confirm' ? 'tracePulse 1.2s ease-in-out infinite' : undefined,
          pointerEvents: 'none',
        }} />
      )}
      {isWatched && runtime!.pulseKey > 0 && (
        <div key={runtime!.pulseKey} style={{
          position: 'absolute', inset: -3,
          borderRadius: 0,
          border: `2px solid ${runtimeColor}`,
          animation: 'runtimePulse 0.7s ease-out 1 forwards',
          pointerEvents: 'none',
        }} />
      )}
      {isWatched && (
        <div
          title={runtime!.lastLabel || `watching ${runtime!.watchedSymbols.join(', ')}`}
          style={{
            position: 'absolute', top: -8, right: -8,
            minWidth: 16, height: 16,
            padding: '0 4px',
            borderRadius: 0,
            background: runtimeColor,
            color: '#0a0d14',
            fontSize: 9,
            fontWeight: 800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-mono)',
            boxShadow: '0 0 8px rgba(34,211,238,0.5)',
            zIndex: 10,
          }}
        >
          {runtime!.callCount > 999 ? '1k+' : runtime!.callCount}
        </div>
      )}

      {hovered && hasTooltip && (
        <RuntimeTooltip runtime={runtime!} color={runtimeColor} />
      )}

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top}    style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right}  style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Left}   style={{ opacity: 0 }} />
    </div>
  )
}
