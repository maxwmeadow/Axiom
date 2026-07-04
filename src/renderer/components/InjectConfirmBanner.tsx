import React, { useState } from 'react'
import { useGraphStore } from '../store/graphStore'

/**
 * InjectConfirmBanner — the warn-and-confirm gate for perturbations.
 *
 * When an agent calls inject_value, the injection sits in pending_confirm
 * until the user approves it here. Denying or ignoring it (2 min timeout)
 * means it never reaches the target process.
 */
export function InjectConfirmBanner() {
  const injections = useGraphStore(s => s.runtimeInjections)
  const [busy, setBusy] = useState<string | null>(null)

  const pending = Object.values(injections)
    .filter(i => i.status === 'pending_confirm')
    .sort((a, b) => a.createdAt - b.createdAt)

  if (pending.length === 0) return null
  const inj = pending[0]

  const respond = async (approved: boolean) => {
    setBusy(inj.id)
    try {
      const res = await fetch('http://127.0.0.1:7743/api/runtime/inject/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: inj.workspaceId,
          injectId: inj.id,
          approved,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
    } catch (err) {
      useGraphStore.getState().addAgentActivity({
        message: `Injection confirmation failed: ${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{
      position: 'absolute',
      top: 16,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 1200,
      maxWidth: 560,
      padding: '14px 18px',
      borderRadius: 12,
      background: 'rgba(24,16,4,0.95)',
      border: '1.5px solid #f59e0b',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(245,158,11,0.25)',
      color: 'var(--text-primary)',
      fontSize: 13,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 15 }}>⚠</span>
        <strong style={{ color: '#f59e0b' }}>Perturbation requested</strong>
        {pending.length > 1 && (
          <span style={{ opacity: 0.6, fontSize: 11 }}>+{pending.length - 1} more queued</span>
        )}
      </div>
      <div style={{ marginBottom: 4, lineHeight: 1.5 }}>
        The agent wants to override{' '}
        <code style={{ color: '#f59e0b' }}>{inj.paramName} = {JSON.stringify(inj.value)}</code>{' '}
        on the next call to <code>{inj.symbol}</code> in <code>{inj.relPath}</code>
        {inj.once ? ' (one-shot)' : ' (persistent!)'}.
      </div>
      <div style={{ opacity: 0.7, fontSize: 11, marginBottom: 10 }}>
        The function executes with the injected value — side effects may occur.
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={() => respond(false)}
          disabled={busy === inj.id}
          style={{
            padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
            background: 'transparent', color: 'var(--text-primary)',
            border: '1px solid rgba(255,255,255,0.2)', fontSize: 12,
          }}
        >
          Deny
        </button>
        <button
          onClick={() => respond(true)}
          disabled={busy === inj.id}
          style={{
            padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
            background: '#f59e0b', color: '#1a1206', fontWeight: 700,
            border: 'none', fontSize: 12,
          }}
        >
          Allow injection
        </button>
      </div>
    </div>
  )
}
