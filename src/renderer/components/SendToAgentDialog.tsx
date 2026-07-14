// SendToAgentDialog — the canvas is the prompt box (UML_UX_PLAN.md U-C).
// Composes a note (+ current selection as durable refs) and enqueues it on
// archd's canvas outbox; any MCP-connected agent picks it up via the
// piggyback trailer, get_canvas_updates, await_canvas, or /axiom:review-canvas.
import React, { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import { useSheetStore } from '../store/sheetStore'

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
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(5, 8, 15, 0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }}>
      <div className="glass-dialog animate-fade-in" style={{ padding: 28, width: 460, maxWidth: '90%', borderRadius: 0 }}>
        <h3 style={{ margin: '0 0 6px 0', fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
          Message the Agent
        </h3>
        <p style={{ margin: '0 0 16px 0', fontSize: 12, color: 'var(--text-secondary)' }}>
          Delivered to any connected agent (Claude Code, Codex, Copilot, …) through the Axiom MCP channel.
          {selection.length > 0 && <> Attached: <code style={{ color: 'var(--accent)' }}>{selection.join(', ')}</code></>}
        </p>

        <form onSubmit={handleSend} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && (
            <div style={{
              color: '#f87171', background: 'rgba(248,113,113,0.08)',
              border: '1.5px solid rgba(248,113,113,0.15)', padding: '10px 14px', fontSize: 12,
            }}>{error}</div>
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

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" onClick={onClose} disabled={sending} style={{
              background: 'transparent', color: 'var(--text-secondary)',
              border: '1px solid var(--border)', padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}>Cancel</button>
            <button type="submit" disabled={sending || !note.trim()} style={{
              background: 'var(--agent-color)', color: '#1a1200', border: 'none',
              padding: '9px 18px', fontSize: 13, fontWeight: 700,
              cursor: sending || !note.trim() ? 'not-allowed' : 'pointer',
              opacity: sending || !note.trim() ? 0.6 : 1,
            }}>{sending ? 'Sending…' : 'Send to Agent'}</button>
          </div>
        </form>

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
      </div>
    </div>
  )
}
