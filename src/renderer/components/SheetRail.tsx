// SheetRail — the drafting-cabinet drawer labels: The Floor pinned on top,
// sheets beneath (UML_UX_PLAN.md "Navigation: the sheet rail").
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import { useSheetStore } from '../store/sheetStore'

export function SheetRail() {
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const { sheets, activeSheetId, visibleSheetIds, fetchSheets, openSheet, toggleSheetVisibility, createSheet, deleteSheet } =
    useSheetStore(useShallow(s => ({
      sheets: s.sheets, activeSheetId: s.activeSheetId, visibleSheetIds: s.visibleSheetIds,
      fetchSheets: s.fetchSheets, openSheet: s.openSheet,
      toggleSheetVisibility: s.toggleSheetVisibility,
      createSheet: s.createSheet, deleteSheet: s.deleteSheet,
    })))
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    if (workspaceId) void fetchSheets(workspaceId)
  }, [workspaceId, fetchSheets])

  const railButtonClass = (active: boolean) => active
    ? 'axiom-sheet-rail__button axiom-sheet-rail__button--active'
    : 'axiom-sheet-rail__button'

  return (
    <div className="axiom-sheet-rail">
      <div style={{
        padding: '10px 12px 6px',
        fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700,
        letterSpacing: '0.1em', color: 'var(--text-dim)',
      }}>
        DRAWINGS
      </div>

      {/* The Floor — the live master canvas, always pinned */}
      <button className={railButtonClass(activeSheetId === null)} onClick={() => void openSheet(workspaceId, null)}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" /><path d="M3 9h18M9 3v18" />
        </svg>
        The Floor
        <span style={{ marginLeft: 'auto', fontSize: 8, fontFamily: 'var(--font-mono)', color: 'var(--ok)' }}>LIVE</span>
      </button>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sheets.map(sheet => (
          <div key={sheet.id} style={{ position: 'relative' }} className="sheet-rail-row">
            <button
              title={visibleSheetIds.includes(sheet.id) ? 'Hide layer' : 'Show layer'}
              aria-label={visibleSheetIds.includes(sheet.id) ? `Hide ${sheet.name}` : `Show ${sheet.name}`}
              onClick={() => void toggleSheetVisibility(workspaceId, sheet.id)}
              style={{
                position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', zIndex: 2,
                width: 14, height: 14, padding: 0, border: '1px solid var(--border)',
                background: visibleSheetIds.includes(sheet.id) ? 'var(--accent)' : 'transparent',
                color: 'var(--bg-base)', cursor: 'pointer', fontSize: 10, lineHeight: '12px',
              }}
            >{visibleSheetIds.includes(sheet.id) ? '✓' : ''}</button>
            <button className={railButtonClass(activeSheetId === sheet.id)} onClick={() => void openSheet(workspaceId, sheet.id)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 4h13l3 3v13H4z" /><path d="M17 4v3h3" />
              </svg>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 16 }}>
                {sheet.name}
              </span>
              {sheet.createdBy === 'agent' && (
                <span style={{ marginLeft: 'auto', fontSize: 8, fontFamily: 'var(--font-mono)', color: 'var(--agent-color)', flexShrink: 0 }}>AI</span>
              )}
            </button>
            {activeSheetId === sheet.id && (
              <button
                title="Delete sheet"
                onClick={() => { if (confirm(`Delete sheet "${sheet.name}"?`)) void deleteSheet(workspaceId, sheet.id) }}
                style={{
                  position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                  background: 'transparent', border: 'none', color: 'var(--text-dim)',
                  fontSize: 11, cursor: 'pointer', padding: 2,
                }}
              >×</button>
            )}
          </div>
        ))}
      </div>

      {creating ? (
        <form
          style={{ padding: 8, borderTop: '1px solid var(--border-dim)' }}
          onSubmit={async (e) => {
            e.preventDefault()
            if (!newName.trim()) return
            const sheet = await createSheet(workspaceId, newName.trim(), '', [])
            setNewName('')
            setCreating(false)
            if (sheet) void openSheet(workspaceId, sheet.id)
          }}
        >
          <input
            className="glass-input"
            autoFocus
            value={newName}
            placeholder="Sheet name…"
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setCreating(false) }}
            style={{ width: '100%', fontSize: 12 }}
          />
        </form>
      ) : (
        <button
          onClick={() => setCreating(true)}
          style={{
            margin: 8, padding: '7px 10px',
            background: 'transparent', color: 'var(--text-secondary)',
            border: '1px dashed var(--border)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
          }}
        >
          + New Sheet
        </button>
      )}
    </div>
  )
}
