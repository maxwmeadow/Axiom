// NewSheetDialog — lasso a selection → curate it into a named Sheet
// (UML_UX_PLAN.md "Creating and populating sheets"). Mirrors GroupDialog.
import React, { useState } from 'react'
import { useGraphStore } from '../store/graphStore'
import { useSheetStore } from '../store/sheetStore'
import { DialogActions, DialogButton, DialogError, DialogForm, DialogFrame, DialogTitle } from './ui/DialogPrimitives'

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
    <DialogFrame width={420}>
        <DialogTitle>
          New Sheet
        </DialogTitle>
        <DialogForm onSubmit={handleSubmit}>
          {error && (
            <DialogError>{error}</DialogError>
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
          <DialogActions inset>
            <DialogButton type="button" variant="secondary" onClick={onClose} disabled={loading}>Cancel</DialogButton>
            <DialogButton type="submit" variant="primary" disabled={loading}>
              {loading ? 'Creating…' : 'Create Sheet'}
            </DialogButton>
          </DialogActions>
        </DialogForm>
    </DialogFrame>
  )
}
