// SendToAgentDialog - the canvas is the prompt box (UML_UX_PLAN.md U-C).
// Composes a note (+ current selection as durable refs) and enqueues it on
// archd's canvas outbox; any MCP-connected agent picks it up via the
// piggyback trailer, get_canvas_updates, await_canvas, or /axiom:review-canvas.
import React, { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import { useSheetStore } from '../store/sheetStore'
import { DialogActions, DialogButton, DialogError, DialogField, DialogForm, DialogFrame, DialogNote } from './ui/DialogPrimitives'

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
  const { activeSheetId, planned, sendToAgent, messages } = useSheetStore(useShallow(s => ({
    activeSheetId: s.activeSheetId, planned: s.planned,
    sendToAgent: s.sendToAgent, messages: s.messages,
  })))
  const approvedPlans = planned.filter(item => item.approvalStatus === 'approved' && item.status !== 'flattened')
  const pendingProposals = planned.filter(item => item.approvalStatus === 'pending')

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
      setError(err instanceof Error ? err.message : 'Send failed - is archd running?')
    } finally {
      setSending(false)
    }
  }

  return (
    <DialogFrame title="Message the Agent" width={460}>
        <DialogNote>
          Delivered to any connected agent (Claude Code, Codex, Copilot, …) through the Axiom MCP channel.
          {selection.length > 0 && <> Attached: <code>{selection.join(', ')}</code></>}
          {activeSheetId && (
            <>
              {' '}The active sheet's immutable context and build spec are attached:
              {' '}{approvedPlans.length} approved planned element{approvedPlans.length === 1 ? '' : 's'}.
              {pendingProposals.length > 0 && (
                <> {pendingProposals.length} agent proposal{pendingProposals.length === 1 ? ' is' : 's are'} awaiting your approval and will not be dispatched.</>
              )}
            </>
          )}
        </DialogNote>

        <DialogForm onSubmit={handleSend} gap={14}>
          {error && (
            <DialogError>{error}</DialogError>
          )}

          <DialogField label="Message">
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={'e.g. "I moved validators into Payments - should these two files merge? Also, why does checkout talk to Redis directly?"'}
              rows={5}
              className="axiom-dialog-input axiom-dialog-input--textarea"
              autoFocus
            />
          </DialogField>

          <DialogActions>
            <DialogButton type="button" variant="secondary" onClick={onClose} disabled={sending}>Cancel</DialogButton>
            <DialogButton type="submit" variant="agent" disabled={sending || !note.trim()}>
              {sending ? 'Sending…' : activeSheetId ? 'Dispatch Increment' : 'Send to Agent'}
            </DialogButton>
          </DialogActions>
        </DialogForm>

        {recent.length > 0 && (
          <section className="axiom-dialog-history" aria-label="Recent messages">
            <h3 className="axiom-dialog-history__title">Recent messages</h3>
            {recent.map(m => (
              <div className="axiom-dialog-history__row" key={m.id}>
                <span className="axiom-dialog-history__status" data-status={m.status}>{m.status}</span>
                <span className="axiom-dialog-history__message">{m.note}</span>
              </div>
            ))}
          </section>
        )}
    </DialogFrame>
  )
}
