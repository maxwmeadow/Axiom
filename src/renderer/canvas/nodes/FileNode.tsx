import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { FileNodeData, NodeFx } from '../sceneTypes'
import type { RuntimeNodeState } from '../../store/graphStore'
import {
  LIVING_FILE_DELETE_MS,
  LIVING_FILE_SIGNAL_CLOSE_MS,
  useGraphStore,
} from '../../store/graphStore'
import { ShapeBackdrop } from './NodeShell'
import { EditableNodeTitle } from './EditableNodeTitle'
import { AgentPresenceBadge } from './AgentPresenceBadge'
import { LanguageIcon, LanguagePicker } from '../languages'
import { SourcePreviewDialog } from '../../components/SourcePreviewDialog'
import { fitPresentationScale } from '../resizeGeometry'
import { connectionHandleProps } from './connectionChrome'
import { AxiomNodeResizer } from './AxiomNodeResizer'

type SymbolTab = 'functions' | 'variables' | 'classes'


// Every structural life event surfaces the same pop-out card, so a file that is
// born or destroyed inside a collapsed system is as legible as one being
// edited. Only 'classify' stays silent: ownership changes are not life events.
function isLivingFileSignal(fx: NodeFx | null | undefined): fx is NodeFx {
  return !!fx && (
    fx.kind === 'edit' ||
    fx.kind === 'enter' ||
    fx.kind === 'exit' ||
    fx.kind === 'flow-add' ||
    fx.kind === 'flow-update' ||
    fx.kind === 'flow-remove'
  )
}

function useRetainedLivingFileSignal(fx: NodeFx | null | undefined): {
  fx: NodeFx | null
  closing: boolean
} {
  const incoming = isLivingFileSignal(fx) ? fx : null
  const signature = incoming ? `${incoming.kind}:${incoming.key}` : ''
  const [rendered, setRendered] = React.useState<NodeFx | null>(incoming)
  const [closing, setClosing] = React.useState(false)
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    if (incoming) {
      setRendered(incoming)
      setClosing(false)
      return
    }
    if (!rendered) return

    setClosing(true)
    closeTimer.current = setTimeout(() => {
      setRendered(null)
      setClosing(false)
      closeTimer.current = null
    }, LIVING_FILE_SIGNAL_CLOSE_MS)
    return () => {
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current)
        closeTimer.current = null
      }
    }
  }, [signature])

  React.useEffect(() => () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
  }, [])

  return { fx: rendered, closing }
}

function EditableSymbolName({ value, editable, onCommit }: { value: string; editable: boolean; onCommit: (value: string) => void }) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(value)
  React.useEffect(() => { if (!editing) setDraft(value) }, [value, editing])
  if (!editable || !editing) return <span data-node-editable={editable ? 'true' : undefined} title={editable ? 'Double-click to edit' : value} onDoubleClick={editable ? event => {
    event.stopPropagation(); setEditing(true)
  } : undefined} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: editable ? 'text' : undefined, userSelect: 'none' }}>{value}</span>
  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== value) onCommit(next)
  }
  return <input autoFocus className="nodrag nopan" value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') commit(); if (event.key === 'Escape') setEditing(false) }}
    style={{ width: '100%', minWidth: 0, border: 0, borderBottom: '1px solid var(--accent)', outline: 0, background: 'transparent', color: 'var(--text-primary)', font: 'inherit', padding: 0, userSelect: 'text' }} />
}

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
        boxShadow: 'var(--shadow-floating)',
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

export function FileNode({ data, selected, width, height, isConnectable }: NodeProps) {
  const d = data as unknown as FileNodeData
  const livingSignal = useRetainedLivingFileSignal(d.fx)
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
  const livingRevealColor = livingSignal.fx?.kind === 'enter' || livingSignal.fx?.kind === 'flow-add'
    ? '#2fa35d'
    : livingSignal.fx?.kind === 'exit' || livingSignal.fx?.kind === 'flow-remove'
      ? '#b6534b'
      : '#3c8f92'

  // Content renders at base (depth-0) pixel sizes inside a div that is
  // 1/s times the node's box, then uniformly scaled down by s. Every file
  // node is therefore pixel-identical in its own frame at any depth.
  const s = fitPresentationScale(width, height, 220, 110, d.worldScale ?? 1)
  const livingSignalLabel = livingSignal.fx?.kind === 'edit'
    ? 'EDITED'
    : livingSignal.fx?.kind === 'enter'
      ? 'CREATED'
    : livingSignal.fx?.kind === 'exit'
      ? 'DELETED'
    : livingSignal.fx?.kind === 'flow-add'
      ? 'LINK ADDED'
      : livingSignal.fx?.kind === 'flow-remove'
        ? 'LINK REMOVED'
        : 'IMPACT'
  // Apparent zoom of this node on screen — a depth-2 node at viewport zoom 2
  // looks like a depth-0 node at zoom 0.5. Detail states gate on this.
  // Resolved by the semantic-zoom pass. Reading the raw zoom here would make
  // this node re-render on every frame of a zoom animation.
  const detailRevealed = d.detailRevealed ?? false
  // Heat is a percentile rank within the workspace, so a small/fresh project
  // spreads scores across the whole range and everything reads "hot". Keep the
  // bar high and muted — a just-written file is NEW (green pulse), not hot.
  const churnColor = churn > 0.82 ? '#b8563f' : churn > 0.62 ? '#a8803c' : 'transparent'
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
  // Morning Delta review paints the same perimeter channel: during a review
  // the question is "what changed", so the diff outranks the heat reading it
  // would otherwise show. Colors match the living choreography exactly —
  // green created, teal edited — so a mark and a live event read as one
  // vocabulary rather than two.
  // An agent reading this file. Deliberately a soft outer halo, not a border
  // treatment: attention must never be mistaken for a change. The perimeter
  // channel belongs to churn and to delta marks.
  const agentReading = !!(d as any).agentReading
  const deltaMark = d.deltaMark ?? null
  const deltaColor = deltaMark === 'created' ? '#2fa35d'
    : deltaMark === 'updated' ? '#3c8f92'
      : deltaMark === 'deleted' ? '#b6534b'
        : null
  const perimeter = deltaColor
    ?? (churn > 0.82 ? '#b8563f'
      : churn > 0.62 ? '#a8803c'
        : 'var(--border)')
  const perimeterW = deltaColor ? (d.deltaFocused ? 2.4 : 1.6)
    : churn > 0.62 ? 1.3 : 1

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
  const suppliedSymbols = d.symbols
  const [symbols, setSymbols] = React.useState<any[] | null>(suppliedSymbols ?? null)
  const [symbolsLoading, setSymbolsLoading] = React.useState(false)
  const [activeTab, setActiveTab] = React.useState<SymbolTab>('functions')
  const [previewSymbol, setPreviewSymbol] = React.useState<any | null>(null)
  const symbolRequestRef = React.useRef(0)
  const symbolNodeIdRef = React.useRef(d.id)

  React.useEffect(() => {
    const request = ++symbolRequestRef.current
    if (symbolNodeIdRef.current !== d.id) {
      symbolNodeIdRef.current = d.id
      setSymbols(suppliedSymbols ?? null)
      setSymbolsLoading(false)
      return
    }
    if (suppliedSymbols) {
      setSymbols(suppliedSymbols)
      setSymbolsLoading(false)
      const first = (['functions', 'variables', 'classes'] as const).find(
        tab => suppliedSymbols.some(sym => tabForKind(sym.kind) === tab)
      )
      if (first && !d.onSymbolsChange) setActiveTab(current =>
        suppliedSymbols.some(sym => tabForKind(sym.kind) === current) ? current : first
      )
      return
    }
    if ((detailRevealed || d.onSymbolsChange) && !symbols) {
      const controller = new AbortController()
      setSymbolsLoading(true)
      fetch(`http://127.0.0.1:7744/api/files/${d.id}/symbols?workspace=${encodeURIComponent(workspaceId)}`, { signal: controller.signal })
        .then(res => {
          if (!res.ok) throw new Error()
          return res.json()
        })
        .then(data => {
          if (symbolRequestRef.current !== request) return
          const syms = Array.isArray(data) ? data : []
          setSymbols(syms)
          setSymbolsLoading(false)
          // Default to the first non-empty category so class-only files
          // don't open on an empty "functions" tab.
          const first = (['functions', 'variables', 'classes'] as const).find(
            tab => syms.some((sym: any) => tabForKind(sym.kind) === tab)
          )
          if (first && !d.onSymbolsChange) setActiveTab(current =>
            syms.some((sym: any) => tabForKind(sym.kind) === current) ? current : first
          )
        })
        .catch(error => {
          if (symbolRequestRef.current !== request) return
          if (error instanceof DOMException && error.name === 'AbortError') {
            setSymbolsLoading(false)
            return
          }
          setSymbols([])
          setSymbolsLoading(false)
        })
      return () => controller.abort()
    }
    setSymbolsLoading(false)
  }, [detailRevealed, d.id, workspaceId, suppliedSymbols, symbols])

  const handleSymbolClick = (sym: any) => {
    if (!editableSymbols && sym.lineStart > 0) setPreviewSymbol(sym)
  }

  // Filter symbols based on the active tab
  const filteredSymbols = React.useMemo(() => {
    if (!symbols) return []

    return symbols.filter(sym => tabForKind(sym.kind) === activeTab)
  }, [symbols, activeTab])
  const editableSymbols = Boolean(d.onSymbolsChange)
  const updateSymbols = (next: any[]) => {
    setSymbols(next)
    d.onSymbolsChange?.(next)
  }
  const addSymbolForActiveTab = () => {
    const kind = activeTab === 'functions' ? 'function' : activeTab === 'classes' ? 'class' : 'variable'
    const baseName = activeTab === 'functions' ? 'newFunction' : activeTab === 'classes' ? 'NewClass' : 'newVariable'
    updateSymbols([...(symbols ?? []), { name: baseName, kind, lineStart: 0, lineEnd: 0 }])
  }
  const tabs: SymbolTab[] = d.umlKind === 'class' ? ['functions', 'variables'] : ['functions', 'variables', 'classes']
  // Authoring capability must not bypass semantic zoom. Sheet leaves use the
  // same identity/detail threshold as live Floor leaves; their controls become
  // available once the detailed state has faded in.
  const detailAlpha = detailRevealed ? 1 : 0

  // Muted workbench ink for symbol kinds — reads as engraved type on parchment,
  // not neon. (Runtime state, not symbol kind, is what glows on this canvas.)
  const renderSymbolIcon = (kind: string) => {
    switch (kind.toLowerCase()) {
      case 'function':
      case 'method':
        return <span style={{ color: '#29746a', marginRight: 4, fontFamily: 'var(--font-mono)' }}>ƒ</span>
      case 'class':
        return <span style={{ color: '#a06a34', marginRight: 4, fontFamily: 'var(--font-mono)' }}>C</span>
      case 'interface':
        return <span style={{ color: '#4f7d5a', marginRight: 4, fontFamily: 'var(--font-mono)' }}>I</span>
      case 'type':
        return <span style={{ color: '#8a5a67', marginRight: 4, fontFamily: 'var(--font-mono)' }}>T</span>
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
        cursor: 'grab',
        transition: 'opacity 0.3s ease, box-shadow 0.35s ease-out',
        opacity: dimmed ? 0.22 : 1,
        filter: dimmed ? 'saturate(0.5)' : undefined,
        userSelect: 'none',
        // Reading halo rides outside the frame so it cannot be confused with
        // the create/edit pulses, which live on the perimeter itself.
        boxShadow: agentReading
          ? '0 0 0 2px rgba(139,124,214,0.55), 0 0 18px 4px rgba(139,124,214,0.28)'
          : undefined,
        // Live choreography: creation is a strong materialization; live
        // classification is a quieter settle into architectural ownership.
        // Deletion is held open for the whole severance window so the file is
        // still on the Floor while its fuses burn, then dissolves as it
        // unmounts. Linear timing keeps those keyframe stops truthful.
        '--living-delete-hold': `${LIVING_FILE_DELETE_MS}ms`,
        animation: d.fx?.kind === 'enter'
          ? 'axiomMaterialize 0.55s cubic-bezier(0.22,1,0.36,1) both'
          : d.fx?.kind === 'exit'
            ? 'axiomDematerializeRed var(--living-delete-hold) linear both'
          : d.fx?.kind === 'classify'
            ? 'axiomClassifySettle 0.7s cubic-bezier(0.22,1,0.36,1) both'
            : undefined,
      } as React.CSSProperties}
    >
      <AgentPresenceBadge presence={d.agentPresence} scale={Math.max(0.8, Math.min(1.1, s))} />
      {/* Preview plane: node visuals ride the predicted post-drop offset.
          Interaction chrome (resizer, connection handles) stays outside on
          the raw node frame so selection outlines never shift or teleport. */}
      <div
        className="axiom-file-node__normal"
        style={{
          position: 'absolute',
          inset: 0,
          transform: `translate(${translateX}px, ${translateY}px)`,
          transition: translateX !== 0 || translateY !== 0
            ? 'transform 0.22s cubic-bezier(0.25,1,0.5,1)'
            : undefined,
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
      <ShapeBackdrop shape={shellShape} stroke={perimeter} strokeWidth={perimeterW}
        headBand={shellShape === 'box' || shellShape === 'classbox' ? 29 : undefined}
        headBandOpacity={detailAlpha} />
      <>
      {/* Name compartment: icon + filename left, line count right. Rule is
          INSET (not full-bleed) so it never collides with shaped silhouettes. */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        minWidth: 0,
        flexShrink: 0,
        paddingBottom: 5,
        paddingRight: 20,   // clears the corner line-count figure
        borderBottom: '1px solid var(--border-dim)',
        opacity: detailAlpha,
        transition: 'opacity 0.25s ease',
        pointerEvents: detailAlpha > 0.8 ? 'auto' : 'none',
      }}>
        {/* Language icon ALWAYS — class-ness is expressed by the node SHAPE
            (chamfered classbox), never by hijacking the icon slot. */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0,
          flex: shellShape === 'cylinder' ? '0 1 auto' : 1,
          maxWidth: shellShape === 'cylinder' ? 'calc(100% - 2px)' : '100%',
          ...(shellShape === 'cylinder' ? {
            // Content-sized mask: preserve the rim everywhere except behind
            // the icon/title, with deliberate breathing room at both ends.
            background: 'var(--bg-surface)',
            padding: '2px 7px 2px 5px',
            marginLeft: -5,
          } : {}),
        }}>
        <LanguagePicker value={d.language ?? ''} onChange={d.onLanguageChange} />
        <EditableNodeTitle value={classFirst ? d.displayName : d.label} onRename={d.onRename} title={d.relPath} style={{
          fontSize: 12,
          color: 'var(--text-primary)',
          fontWeight: 600,
          letterSpacing: '-0.01em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: shellShape === 'cylinder' ? '0 1 auto' : 1,
          minWidth: 0,
          fontFamily: 'var(--font-mono)',
        }} />
        </div>
          {/* class-first: the file IS its class — class name leads; the real
              filename lives in the hover tooltip, never cramped inline. */}
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
          opacity: detailAlpha,
          transition: 'opacity 0.25s ease',
        }}>{d.lineCount}</span>
      )}

      </>

      {(
        /* State 1: Compact — line count lives in the header, only churn here */
        <div style={{
          position: 'absolute',
          inset: shellShape === 'cylinder' ? '15px 14px 13px' : '10px 14px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          minWidth: 0,
          textAlign: 'center',
          opacity: 1 - detailAlpha,
          transition: 'opacity 0.25s ease',
          pointerEvents: detailAlpha < 0.2 ? 'auto' : 'none',
        }}>
          <LanguagePicker value={d.language ?? ''} onChange={d.onLanguageChange} iconSize={30} />
          <EditableNodeTitle value={classFirst ? d.displayName : d.label} onRename={d.onRename} title={d.relPath} style={{
            width: '100%',
            minWidth: 0,
            fontSize: 19,
            lineHeight: 1.1,
            color: 'var(--text-primary)',
            fontWeight: 700,
            letterSpacing: '-0.025em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textAlign: 'center',
            fontFamily: 'var(--font-mono)',
          }} />
          {churn > 0.62 && <span style={{
            position: 'absolute',
            bottom: 0,
            fontSize: 8,
            color: churnColor,
            fontFamily: 'var(--font-mono)',
            opacity: 0.7,
          }}>{churn > 0.82 ? 'hot' : 'active'}</span>}
        </div>
      )}
      {(
        /* State 2 & 3: Scrollable Viewports */
        <div style={{
          display: 'flex',
          flexDirection: 'row',
          flex: 1,
          minHeight: 0,
          gap: 4,
          marginTop: 2,
          opacity: detailAlpha,
          transition: 'opacity 0.25s ease',
          pointerEvents: detailAlpha > 0.8 ? 'auto' : 'none',
        }} className="nodrag nopan">
          {/* Scrollable symbols list viewport */}
          <div
            className="symbol-scroll nodrag"
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
                    onKeyDown={event => {
                      if (!editableSymbols && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault()
                        handleSymbolClick(sym)
                      }
                    }}
                    className="symbol-row nodrag"
                    role={!editableSymbols && sym.lineStart > 0 ? 'button' : undefined}
                    tabIndex={!editableSymbols && sym.lineStart > 0 ? 0 : undefined}
                    title={!editableSymbols && sym.lineStart > 0 ? `Open ${sym.name} in source` : undefined}
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
                      cursor: !editableSymbols && sym.lineStart > 0 ? 'pointer' : undefined,
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
                      <EditableSymbolName value={sym.name} editable={editableSymbols} onCommit={name =>
                        updateSymbols(symbols!.map(item => item === sym ? { ...item, name } : item))} />
                    </div>
                    {editableSymbols ? <button className="nodrag nopan" title="Remove symbol" onPointerDown={event => event.stopPropagation()}
                      onClick={event => { event.stopPropagation(); updateSymbols(symbols!.filter(item => item !== sym)) }}
                      style={{ border: 0, background: 'transparent', color: 'var(--text-dim)', padding: 0, cursor: 'pointer' }}>×</button>
                      : <span style={{ color: 'var(--text-dim)', fontSize: 7, flexShrink: 0, marginLeft: 4 }}>: {sym.lineStart}</span>}
                  </div>
                )
              })
            )}
            {editableSymbols && <button className="nodrag nopan" title={`Add ${activeTab.slice(0, -1)}`}
              onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); addSymbolForActiveTab() }}
              style={{
                width: '100%', minHeight: 14, marginTop: 2, border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--accent)', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: '1px 4px', flexShrink: 0,
              }}>+</button>}
          </div>

          {/* Vertical tab rail, flush right */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            flexShrink: 0,
            marginLeft: 'auto',
          }}>
              {tabs.map(tab => (
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
      {livingSignal.fx && (
        <div
          className={
            `axiom-living-file-signal${livingSignal.closing
              ? ' axiom-living-file-signal--closing'
              : ''}`
          }
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 40,
            pointerEvents: 'none',
            background: 'transparent',
            '--living-signal-close': `${LIVING_FILE_SIGNAL_CLOSE_MS}ms`,
          } as React.CSSProperties}
        >
          <div style={{
            position: 'absolute',
            inset: 0,
            width: `${100 / s}%`,
            height: `${100 / s}%`,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 16px',
            border: `2px solid ${livingRevealColor}`,
            background:
              `linear-gradient(110deg, color-mix(in srgb, ${livingRevealColor} 16%, var(--bg-raised)), ` +
              'var(--bg-raised) 68%)',
            boxShadow:
              `4px 4px 0 color-mix(in srgb, ${livingRevealColor} 24%, transparent), ` +
              `0 0 24px color-mix(in srgb, ${livingRevealColor} 48%, transparent)`,
            transform: `scale(${s})`,
            transformOrigin: 'top left',
          }}>
            <div style={{
              width: 38,
              height: 38,
              display: 'grid',
              flex: '0 0 38px',
              placeItems: 'center',
              border: `1px solid color-mix(in srgb, ${livingRevealColor} 65%, var(--border))`,
              background: 'var(--bg-surface)',
            }}>
              <LanguageIcon language={d.language ?? ''} size={25} />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                color: livingRevealColor,
                fontFamily: 'var(--font-mono)',
                fontSize: 8,
                fontWeight: 900,
                letterSpacing: '0.13em',
                lineHeight: 1,
              }}>
                {livingSignalLabel}
              </div>
              <div style={{
                marginTop: 7,
                overflow: 'hidden',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                fontSize: 14,
                fontWeight: 750,
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {d.label}
              </div>
            </div>
            <div
              className="axiom-living-file-signal__beacon"
              style={{ background: livingRevealColor, boxShadow: `0 0 12px ${livingRevealColor}` }}
            />
          </div>
        </div>
      )}
      {/* Just created: a green pop-pulse announces the file was made. */}
      {d.fx?.kind === 'enter' && (
        <div key={`fx-${d.fx.key}`} style={{
          position: 'absolute', inset: -3,
          border: '2px solid #2fa35d',
          animation: 'axiomCreatePulse 0.9s ease-out 1 forwards',
          pointerEvents: 'none',
        }} />
      )}
      {/* Being destroyed: a red ring collapses inward while the severed
          relationships burn outward from this node. */}
      {d.fx?.kind === 'exit' && (
        <div key={`fx-${d.fx.key}`} style={{
          position: 'absolute', inset: -3,
          border: '2px solid #b6534b',
          animation: 'axiomDeletePulse 0.9s cubic-bezier(0.4,0,0.2,1) 1 forwards',
          pointerEvents: 'none',
        }} />
      )}
      {/* Live edit landed: the file was just rewritten — a one-shot teal
          perimeter pulse so the change is visible on the map. */}
      {d.fx?.kind === 'edit' && (
        <div key={`fx-${d.fx.key}`} style={{
          position: 'absolute', inset: -3,
          border: '2px solid var(--accent)',
          animation: 'axiomEditPulse 0.75s ease-out 1 forwards',
          pointerEvents: 'none',
        }} />
      )}
      {d.fx?.kind.startsWith('flow-') && (
        <div key={`fx-${d.fx.key}`} style={{
          position: 'absolute', inset: -3,
          border: `2px solid ${d.fx.kind === 'flow-add' ? '#2fa35d' : d.fx.kind === 'flow-remove' ? '#b6534b' : '#3c8f92'}`,
          animation: 'axiomFlowArrival 0.8s ease-out 1 forwards',
          pointerEvents: 'none',
        }} />
      )}
      {/* A loose file found architectural ownership: a restrained olive
          perimeter confirms classification without competing with creation. */}
      {d.fx?.kind === 'classify' && (
        <div key={`fx-${d.fx.key}`} style={{
          position: 'absolute', inset: -3,
          border: '1px dashed #667a55',
          animation: 'axiomClassifyPulse 0.9s ease-out 1 forwards',
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
      </div>

      <AxiomNodeResizer nodeId={d.id} presentationScale={s} nodeWidth={width} nodeHeight={height} isVisible={selected}
        isResizable={typeof onResizeStart === 'function' && typeof onResizeEnd === 'function'}
        minWidth={1} minHeight={1} color="var(--accent)"
        onResizeStart={onResizeStart} onResizeEnd={onResizeEnd} />

      {previewSymbol && <SourcePreviewDialog
        fileId={d.id}
        workspaceId={workspaceId}
        symbol={previewSymbol}
        onClose={() => setPreviewSymbol(null)}
      />}

      <Handle id="source-top" type="source" position={Position.Top} {...connectionHandleProps(isConnectable, s)} />
      <Handle id="source-right" type="source" position={Position.Right} {...connectionHandleProps(isConnectable, s)} />
      <Handle id="source-bottom" type="source" position={Position.Bottom} {...connectionHandleProps(isConnectable, s)} />
      <Handle id="source-left" type="source" position={Position.Left} {...connectionHandleProps(isConnectable, s)} />
      <Handle id="target-top" type="target" position={Position.Top} {...connectionHandleProps(isConnectable, s)} />
      <Handle id="target-right" type="target" position={Position.Right} {...connectionHandleProps(isConnectable, s)} />
      <Handle id="target-bottom" type="target" position={Position.Bottom} {...connectionHandleProps(isConnectable, s)} />
      <Handle id="target-left" type="target" position={Position.Left} {...connectionHandleProps(isConnectable, s)} />
    </div>
  )
}
