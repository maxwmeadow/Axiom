// SheetRail — the drafting-cabinet drawer labels: The Floor pinned on top,
// sheets beneath (UML_UX_PLAN.md "Navigation: the sheet rail").
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { untakenSheetName } from '../../shared/sheetNames'
import { useGraphStore } from '../store/graphStore'
import { useSheetStore, type Sheet } from '../store/sheetStore'

const SHEET_KIND_LABELS: Record<Sheet['kind'], string> = {
  structure: 'STR',
  class: 'CLS',
  sequence: 'SEQ',
  intent: 'INT',
}

function FloorIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" />
      <path d="M3 9h18M9 3v18" />
    </svg>
  )
}

function SheetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4h13l3 3v13H4z" />
      <path d="M17 4v3h3" />
    </svg>
  )
}

export function SheetRail() {
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const { sheets, activeSheetId, visibleSheetIds, fetchSheets, openSheet, toggleSheetVisibility, createSheet, deleteSheet } =
    useSheetStore(useShallow(s => ({
      sheets: s.sheets,
      activeSheetId: s.activeSheetId,
      visibleSheetIds: s.visibleSheetIds,
      fetchSheets: s.fetchSheets,
      openSheet: s.openSheet,
      toggleSheetVisibility: s.toggleSheetVisibility,
      createSheet: s.createSheet,
      deleteSheet: s.deleteSheet,
    })))
  const [creating, setCreating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [newName, setNewName] = useState('New Sheet')
  const [createError, setCreateError] = useState<string | null>(null)
  const newNameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (workspaceId) void fetchSheets(workspaceId)
  }, [workspaceId, fetchSheets])

  useEffect(() => {
    if (!creating) return
    newNameInput.current?.focus()
    newNameInput.current?.select()
  }, [creating])

  const beginCreating = () => {
    setNewName(untakenSheetName(sheets, 'New Sheet'))
    setCreateError(null)
    setCreating(true)
  }

  const cancelCreating = () => {
    if (submitting) return
    setCreateError(null)
    setCreating(false)
  }

  const submitNewSheet = async (event: FormEvent) => {
    event.preventDefault()
    const name = newName.trim()
    if (!name || submitting) return

    setSubmitting(true)
    setCreateError(null)
    try {
      const sheet = await createSheet(workspaceId, name, '', [])
      setCreating(false)
      void openSheet(workspaceId, sheet.id)
    } catch (err) {
      // Stay in the row with the name still typed: the fix is almost always a
      // one-word edit, not starting over.
      setCreateError(err instanceof Error ? err.message : 'Could not create the sheet.')
      newNameInput.current?.focus()
      newNameInput.current?.select()
    } finally {
      setSubmitting(false)
    }
  }

  const railButtonClass = (active: boolean) => [
    'axiom-sheet-rail__button',
    active ? 'axiom-sheet-rail__button--active' : '',
  ].filter(Boolean).join(' ')

  return (
    <aside className="axiom-sheet-rail" aria-label="Drawings">
      <header className="axiom-sheet-rail__titlebar">
        <span>Drawings</span>
        <span className="axiom-sheet-rail__title-meta" aria-label={`${sheets.length} overlay sheets`}>
          {String(sheets.length).padStart(2, '0')} SHEETS
        </span>
      </header>

      <div className="axiom-sheet-rail__section-label">
        <span>Live model</span>
        <span className="axiom-sheet-rail__section-rule" />
      </div>

      {/* The Floor — the live master canvas, always pinned. */}
      <button
        className={`${railButtonClass(activeSheetId === null)} axiom-sheet-rail__button--floor`}
        aria-current={activeSheetId === null ? 'page' : undefined}
        onClick={() => void openSheet(workspaceId, null)}
      >
        <span className="axiom-sheet-rail__document-icon"><FloorIcon /></span>
        <span className="axiom-sheet-rail__name">The Floor</span>
        <span className="axiom-sheet-rail__live">Live</span>
      </button>

      <div className="axiom-sheet-rail__section-label axiom-sheet-rail__section-label--overlays">
        <span>Overlay sheets</span>
        <span className="axiom-sheet-rail__section-rule" />
        <button
          type="button"
          className="axiom-sheet-rail__add-sheet"
          aria-label="Create new overlay sheet"
          aria-expanded={creating}
          disabled={creating}
          onClick={beginCreating}
        >
          +
        </button>
      </div>

      <div className="axiom-sheet-rail__list">
        {creating && (
          <form className="axiom-sheet-rail__row axiom-sheet-rail__row--creating" onSubmit={submitNewSheet}>
            <span className="axiom-sheet-rail__visibility-slot" aria-hidden="true" />
            <span className="axiom-sheet-rail__document-icon"><SheetIcon /></span>
            <input
              ref={newNameInput}
              className="axiom-sheet-rail__name-input"
              aria-label="New sheet name"
              value={newName}
              disabled={submitting}
              spellCheck={false}
              aria-invalid={createError ? true : undefined}
              onChange={event => {
                setNewName(event.target.value)
                setCreateError(null)
              }}
              onKeyDown={event => {
                event.stopPropagation()
                if (event.key === 'Escape') cancelCreating()
              }}
            />
            <span className="axiom-sheet-rail__commit-hint" aria-hidden="true">
              {submitting ? '…' : '↵'}
            </span>
          </form>
        )}

        {creating && createError && (
          <p className="axiom-sheet-rail__create-error" role="alert">{createError}</p>
        )}

        {sheets.map(sheet => {
          const active = activeSheetId === sheet.id
          const visible = visibleSheetIds.includes(sheet.id)
          return (
            <div
              key={sheet.id}
              className={[
                'axiom-sheet-rail__row',
                active ? 'axiom-sheet-rail__row--active' : '',
              ].filter(Boolean).join(' ')}
            >
              <button
                type="button"
                className={[
                  'axiom-sheet-rail__visibility',
                  visible ? 'axiom-sheet-rail__visibility--visible' : '',
                ].filter(Boolean).join(' ')}
                title={visible ? 'Hide layer' : 'Show layer'}
                aria-label={visible ? `Hide ${sheet.name}` : `Show ${sheet.name}`}
                aria-pressed={visible}
                onClick={() => void toggleSheetVisibility(workspaceId, sheet.id)}
              >
                {visible && (
                  <svg viewBox="0 0 12 12" aria-hidden="true">
                    <path d="m2.1 6.2 2.3 2.2 5.5-5.2" />
                  </svg>
                )}
              </button>

              <button
                type="button"
                className={`${railButtonClass(active)} axiom-sheet-rail__button--sheet`}
                aria-current={active ? 'page' : undefined}
                onClick={() => void openSheet(workspaceId, sheet.id)}
              >
                <span className="axiom-sheet-rail__document-icon"><SheetIcon /></span>
                <span className="axiom-sheet-rail__name" title={sheet.name}>{sheet.name}</span>
                <span className="axiom-sheet-rail__kind">{SHEET_KIND_LABELS[sheet.kind]}</span>
                {sheet.createdBy === 'agent' && <span className="axiom-sheet-rail__agent" title="Created by agent">AI</span>}
              </button>

              {active && (
                <button
                  type="button"
                  className="axiom-sheet-rail__delete"
                  aria-label={`Delete ${sheet.name}`}
                  title="Delete sheet"
                  onClick={() => {
                    if (confirm(`Delete sheet "${sheet.name}"?`)) void deleteSheet(workspaceId, sheet.id)
                  }}
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
