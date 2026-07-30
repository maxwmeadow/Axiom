import React, { useState } from 'react'
import { useGraphStore } from '../store/graphStore'
import { useShallow } from 'zustand/react/shallow'
import { DialogActions, DialogButton, DialogError, DialogField, DialogForm, DialogFrame, DialogNote } from './ui/DialogPrimitives'

interface GroupDialogProps {
  isOpen: boolean
  onClose: () => void
  selectedFileIds: string[]
  onSuccess: () => void
}

export function GroupDialog({ isOpen, onClose, selectedFileIds, onSuccess }: GroupDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { currentProject, systems, applySnapshot } = useGraphStore(useShallow(s => ({
    currentProject: s.currentProject,
    systems: s.systems,
    applySnapshot: s.applySnapshot,
  })))

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('System name is required')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const isDemo = !window.axiom

      if (isDemo) {
        // Demo mode: mutate store directly
        const systemId = `sys_${Math.random().toString(36).slice(2, 9)}`
        const now = Date.now()
        const newSystem = {
          id: systemId,
          workspaceId: 'demo',
          name: name.trim(),
          parentId: null as string | null,
          source: 'user' as const,
          color: null,
          description: description.trim() || null,
          agentNotes: null,
          depth: 0,
          positionX: 0,
          positionY: 0,
          createdAt: now,
          updatedAt: now,
        }
        useGraphStore.setState(s => ({
          systems: [...s.systems, newSystem],
          files: s.files.map(f =>
            selectedFileIds.includes(f.id) ? { ...f, systemId } : f
          ),
        }))
      } else {
        // Live: call Go REST API
        const workspaceId = currentProject?.id ?? ''
        const sysRes = await fetch('http://127.0.0.1:7743/api/systems', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            name: name.trim(),
            description: description.trim() || null,
            source: 'user',
          }),
        })
        if (!sysRes.ok) throw new Error(await sysRes.text())
        const sys = await sysRes.json() as { id: string }

        // Assign files one by one
        await Promise.all(selectedFileIds.map(fileId =>
          fetch(`http://127.0.0.1:7743/api/files/${fileId}/assign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemId: sys.id }),
          })
        ))

        // Re-fetch snapshot so canvas reflects the new assignments
        const snapRes = await fetch(`http://127.0.0.1:7743/api/snapshot/${workspaceId}`)
        if (snapRes.ok) {
          const snap = await snapRes.json()
          applySnapshot(snap)
        }
      }

      setName('')
      setDescription('')
      onSuccess()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create system')
    } finally {
      setLoading(false)
    }
  }

  return (
    <DialogFrame title="New System" width={420}>
        <DialogForm onSubmit={handleSubmit}>
          {error && (
            <DialogError>
              {error}
            </DialogError>
          )}

          <DialogField label="System name">
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Auth & Session Management"
              className="axiom-dialog-input"
              autoFocus
            />
          </DialogField>

          <DialogField label="Description" optional="optional">
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What this system is responsible for..."
              rows={3}
              className="axiom-dialog-input axiom-dialog-input--textarea"
            />
          </DialogField>

          <DialogNote>
            Grouping <strong>{selectedFileIds.length}</strong> selected{' '}
            {selectedFileIds.length === 1 ? 'file' : 'files'} into this system.
          </DialogNote>

          <DialogActions inset>
            <DialogButton
              type="button"
              onClick={onClose}
              disabled={loading}
              variant="secondary"
            >
              Cancel
            </DialogButton>
            <DialogButton
              type="submit"
              disabled={loading}
              variant="primary"
            >
              {loading ? 'Creating…' : 'Create System'}
            </DialogButton>
          </DialogActions>
        </DialogForm>
    </DialogFrame>
  )
}
