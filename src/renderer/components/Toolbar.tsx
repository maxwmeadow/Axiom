import React, { useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useGraphStore } from '../store/graphStore'

interface ToolbarProps {
  onSearch: () => void
  onOpenProject: () => void
  projectName?: string
}

export function Toolbar({ onSearch, onOpenProject, projectName }: ToolbarProps) {
  const { fitView } = useReactFlow()
  const isIndexing = useGraphStore(s => s.isIndexing)
  const selectionMode = useGraphStore(s => s.selectionMode)
  const setSelectionMode = useGraphStore(s => s.setSelectionMode)
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')

  return (
    <div style={{
      height: 48,
      background: 'var(--bg-surface)',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px',
      gap: 8,
      flexShrink: 0,
      WebkitAppRegion: 'drag',
    }}>
      {/* App logo */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginRight: 16,
        WebkitAppRegion: 'no-drag',
      }}>
        <AxiomLogo />
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
          Axiom
        </span>
        {projectName && (
          <>
            <span style={{ color: 'var(--border)', fontSize: 14 }}>/</span>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{projectName}</span>
          </>
        )}
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Lasso Select / Pan Mode Toggle */}
      <ToolbarBtn
        onClick={() => setSelectionMode(!selectionMode)}
        label={selectionMode ? "Lasso Active" : "Lasso Select"}
        active={selectionMode}
      >
        {selectionMode ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3"/>
          </svg>
        )}
      </ToolbarBtn>

      {/* Investigations (capture replay) */}
      <InvestigationsMenu workspaceId={workspaceId} />

      {/* Search */}
      <ToolbarBtn
        onClick={onSearch}
        label="Search"
        shortcut="⌘K"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
        </svg>
      </ToolbarBtn>

      {/* Open project */}
      <ToolbarBtn onClick={onOpenProject} label="Open project">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      </ToolbarBtn>

      {/* Fit view */}
      <ToolbarBtn onClick={() => fitView({ padding: 0.15, duration: 400 })} label="Fit view">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
        </svg>
      </ToolbarBtn>

      {/* Indexing indicator */}
      {isIndexing && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          color: 'var(--accent)', fontSize: 11,
        }}>
          <span style={{ animation: 'pulse 1.5s ease-in-out infinite', fontSize: 14 }}>⟳</span>
          Indexing…
        </div>
      )}
    </div>
  )
}

interface InvestigationMeta {
  id: string; name: string; commit: string; branch: string
  createdAt: number; durationMs: number; eventCount: number
}

/** Dropdown listing saved investigations; clicking one loads it for replay. */
function InvestigationsMenu({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<InvestigationMeta[]>([])
  const [loading, setLoading] = useState(false)
  const replay = useGraphStore(s => s.replay)
  const startReplay = useGraphStore(s => s.startReplay)

  const load = async () => {
    if (!workspaceId) return
    setLoading(true)
    try {
      const res = await fetch(`http://127.0.0.1:7743/api/investigation/list?workspace=${encodeURIComponent(workspaceId)}`)
      if (res.ok) setItems(((await res.json()).investigations ?? []) as InvestigationMeta[])
    } catch { /* daemon offline */ } finally { setLoading(false) }
  }

  const toggle = () => { const next = !open; setOpen(next); if (next) load() }

  const openReplay = async (id: string) => {
    try {
      const res = await fetch(`http://127.0.0.1:7743/api/investigation/${encodeURIComponent(id)}?workspace=${encodeURIComponent(workspaceId)}`)
      if (res.ok) { startReplay(await res.json()); setOpen(false) }
    } catch { /* ignore */ }
  }

  return (
    <div style={{ position: 'relative', WebkitAppRegion: 'no-drag' }}>
      <ToolbarBtn onClick={toggle} label="Investigations" active={open || !!replay}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9" /><polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
        </svg>
      </ToolbarBtn>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setOpen(false)} />
          <div style={{
            position: 'absolute', top: 38, right: 0, zIndex: 999, width: 320,
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8,
            boxShadow: '0 12px 40px rgba(0,0,0,0.5)', padding: 6, maxHeight: 380, overflowY: 'auto',
          }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '6px 8px', fontWeight: 600 }}>
              INVESTIGATION CAPTURES
            </div>
            {loading && <div style={{ padding: 8, fontSize: 12, color: 'var(--text-secondary)' }}>Loading…</div>}
            {!loading && items.length === 0 && (
              <div style={{ padding: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                No captures yet. Ask your agent to <code>start_investigation</code>, debug, then <code>stop_investigation</code>.
              </div>
            )}
            {items.map(inv => (
              <button key={inv.id} onClick={() => openReplay(inv.id)} style={{
                display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
                border: 'none', borderRadius: 6, padding: '8px', cursor: 'pointer', color: 'var(--text-primary)',
              }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-raised)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.name}</div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'ui-monospace, monospace' }}>
                  {inv.eventCount} events · {(inv.durationMs / 1000).toFixed(1)}s · {inv.branch}@{inv.commit ? inv.commit.slice(0, 7) : '—'}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ToolbarBtn({
  onClick, label, shortcut, active, children
}: {
  onClick: () => void
  label: string
  shortcut?: string
  active?: boolean
  children: React.ReactNode
}) {
  const [hovered, setHovered] = useState(false)
  const bg = active
    ? 'rgba(99,102,241,0.15)'
    : hovered
    ? 'var(--bg-raised)'
    : 'transparent'
  const color = active
    ? 'var(--accent)'
    : hovered
    ? 'var(--text-primary)'
    : 'var(--text-secondary)'
  const border = active ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent'

  return (
    <button
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut})` : label}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        WebkitAppRegion: 'no-drag',
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '5px 9px',
        borderRadius: 6,
        border,
        color,
        background: bg,
        fontSize: 12,
        transition: 'color 0.15s, background 0.15s, border-color 0.15s',
        cursor: 'pointer',
        outline: 'none',
      }}
    >
      {children}
      {shortcut && (
        <kbd style={{
          fontSize: 9, color: 'var(--text-dim)',
          background: 'var(--bg-overlay)', borderRadius: 3,
          padding: '1px 4px', border: '1px solid var(--border)',
        }}>{shortcut}</kbd>
      )}
    </button>
  )
}

function AxiomLogo() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <polygon points="10,1 19,6 19,14 10,19 1,14 1,6" fill="rgba(99,102,241,0.15)" stroke="var(--accent)" strokeWidth="1.5"/>
      <circle cx="10" cy="10" r="3" fill="var(--accent)" opacity="0.8"/>
      <line x1="10" y1="1" x2="10" y2="7" stroke="var(--accent)" strokeWidth="1" opacity="0.5"/>
      <line x1="10" y1="13" x2="10" y2="19" stroke="var(--accent)" strokeWidth="1" opacity="0.5"/>
      <line x1="1" y1="6" x2="7" y2="9" stroke="var(--accent)" strokeWidth="1" opacity="0.5"/>
      <line x1="13" y1="11" x2="19" y2="14" stroke="var(--accent)" strokeWidth="1" opacity="0.5"/>
      <line x1="19" y1="6" x2="13" y2="9" stroke="var(--accent)" strokeWidth="1" opacity="0.5"/>
      <line x1="7" y1="11" x2="1" y2="14" stroke="var(--accent)" strokeWidth="1" opacity="0.5"/>
    </svg>
  )
}
