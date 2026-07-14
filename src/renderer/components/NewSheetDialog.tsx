// NewSheetDialog — lasso a selection → curate it into a named Sheet
// (UML_UX_PLAN.md "Creating and populating sheets"). Mirrors GroupDialog.
import React, { useState } from 'react'
import { useGraphStore } from '../store/graphStore'
import { useSheetStore } from '../store/sheetStore'

interface NewSheetDialogProps {
  isOpen: boolean
  onClose: () => void
  selectedFileIds: string[]
  onSuccess: () => void
}

export function NewSheetDialog({ isOpen, onClose, selectedFileIds, onSuccess }: NewSheetDialogProps) {
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const createSheet = useSheetStore(s => s.createSheet)
  const openSheet = useSheetStore(s => s.openSheet)

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Sheet name is required')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const sheet = await createSheet(workspaceId, name.trim(), purpose.trim(), selectedFileIds)
      if (!sheet) throw new Error('Create failed — is archd running?')
      setName('')
      setPurpose('')
      onSuccess()
      onClose()
      void openSheet(workspaceId, sheet.id)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create sheet')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(5, 8, 15, 0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }}>
      <div className="glass-dialog animate-fade-in" style={{ padding: 28, width: 420, maxWidth: '90%', borderRadius: 0 }}>
        <h3 style={{ margin: '0 0 20px 0', fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
          New Sheet
        </h3>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {error && (
            <div style={{
              color: '#f87171', background: 'rgba(248,113,113,0.08)',
              border: '1.5px solid rgba(248,113,113,0.15)', padding: '10px 14px', fontSize: 12,
            }}>{error}</div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, letterSpacing: '0.05em' }}>
              SHEET NAME
            </label>
            <input
              type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder='e.g. "Payment flow"' className="glass-input" autoFocus
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, letterSpacing: '0.05em' }}>
              PURPOSE <span style={{ opacity: 0.5, fontWeight: 400 }}>(optional — shown in the title block)</span>
            </label>
            <input
              type="text" value={purpose} onChange={e => setPurpose(e.target.value)}
              placeholder="What story does this sheet tell?" className="glass-input"
            />
          </div>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', opacity: 0.75 }}>
            Curating <strong style={{ color: 'var(--accent)' }}>{selectedFileIds.length}</strong> selected{' '}
            {selectedFileIds.length === 1 ? 'file' : 'files'} onto this sheet. Elements stay live —
            renames and deletions in the codebase show up here.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
            <button type="button" onClick={onClose} disabled={loading} style={{
              background: 'transparent', color: 'var(--text-secondary)',
              border: '1px solid var(--border)', padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}>Cancel</button>
            <button type="submit" disabled={loading} style={{
              background: 'linear-gradient(135deg, var(--accent) 0%, #4f46e5 100%)',
              color: '#fff', border: 'none', padding: '9px 18px', fontSize: 13, fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1,
            }}>{loading ? 'Creating…' : 'Create Sheet'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
