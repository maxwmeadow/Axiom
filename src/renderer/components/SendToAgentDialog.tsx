// SendToAgentDialog — the canvas is the prompt box (UML_UX_PLAN.md U-C).
// Composes a note (+ current selection as durable refs) and enqueues it on
// archd's canvas outbox; any MCP-connected agent picks it up via the
// piggyback trailer, get_canvas_updates, await_canvas, or /axiom:review-canvas.
import React, { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import { useSheetStore } from '../store/sheetStore'
import { DialogActions, DialogButton, DialogError, DialogForm, DialogFrame, DialogTitle } from './ui/DialogPrimitives'

interface SendToAgentDialogProps {
  isOpen: boolean
  onClose: () => void
}

export function SendToAgentDialog({ isOpen, onClose }: SendToAgentDialogProps) {
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { workspaceId, selectedNodeId, files, systems, infraNodes } = useGraphStore(useShallow(s => ({
    workspaceId: s.currentProject?.id ?? '',
    selectedNodeId: s.selectedNodeId,
    files: s.files, systems: s.systems, infraNodes: s.infraNodes,
  })))
  const { activeSheetId, sendToAgent, messages } = useSheetStore(useShallow(s => ({
    activeSheetId: s.activeSheetId, sendToAgent: s.sendToAgent, messages: s.messages,
  })))

  if (!isOpen) return null

  // Durable ref for the current selection (ASM URI form).
  const selection: string[] = []
  if (selectedNodeId) {
    const f = files.find(x => x.id === selectedNodeId)
    const sys = systems.find(x => x.id === selectedNodeId)
    const inf = infraNodes.find(x => x.id === selectedNodeId)
    if (f) selection.push(`file://${f.relPath}`)
    else if (sys) selection.push(`sys://${sys.name}`)
    else if (inf) selection.push(`infra://${inf.service || inf.category}/${inf.name}`)
  }

  const recent = messages.slice(-3).reverse()

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!note.trim()) {
      setError('Write a note first')
      return
    }
    setSending(true)
    setError(null)
    try {
      await sendToAgent(workspaceId, note.trim(), selection, activeSheetId)
      setNote('')
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Send failed — is archd running?')
    } finally {
      setSending(false)
    }
  }

  return (
    <DialogFrame width={460}>
        <DialogTitle compact>
          Message the Agent
        </DialogTitle>
        <p style={{ margin: '0 0 16px 0', fontSize: 12, color: 'var(--text-secondary)' }}>
          Delivered to any connected agent (Claude Code, Codex, Copilot, …) through the Axiom MCP channel.
          {selection.length > 0 && <> Attached: <code style={{ color: 'var(--accent)' }}>{selection.join(', ')}</code></>}
        </p>

        <DialogForm onSubmit={handleSend} gap={14}>
          {error && (
            <DialogError>{error}</DialogError>
          )}

          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder={'e.g. "I moved validators into Payments — should these two files merge? Also, why does checkout talk to Redis directly?"'}
            rows={5}
            className="glass-input"
            style={{ resize: 'none', fontSize: 13, lineHeight: 1.5 }}
            autoFocus
          />

          <DialogActions>
            <DialogButton type="button" variant="secondary" onClick={onClose} disabled={sending}>Cancel</DialogButton>
            <DialogButton type="submit" variant="agent" disabled={sending || !note.trim()}>
              {sending ? 'Sending…' : 'Send to Agent'}
            </DialogButton>
          </DialogActions>
        </DialogForm>

        {recent.length > 0 && (
          <div style={{ marginTop: 18, borderTop: '1px solid var(--border-dim)', paddingTop: 10 }}>
            <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: 6 }}>
              RECENT MESSAGES
            </div>
            {recent.map(m => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-secondary)', padding: '3px 0' }}>
                <span style={{
                  fontSize: 8, fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: '0.06em',
                  padding: '2px 5px', flexShrink: 0,
                  color: m.status === 'answered' ? 'var(--ok)' : m.status === 'delivered' ? 'var(--accent)' : 'var(--warn)',
                  border: `1px solid ${m.status === 'answered' ? 'var(--ok)' : m.status === 'delivered' ? 'var(--accent)' : 'var(--warn)'}`,
                }}>{m.status.toUpperCase()}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.note}</span>
              </div>
            ))}
          </div>
        )}
    </DialogFrame>
  )
}
