import React, { useEffect, useMemo, useState } from 'react'
import { useGraphStore } from '../store/graphStore'
import { useRegistryStore } from '../store/registryStore'
import { brandIcon, CATEGORY_GLYPHS, officialServiceIcon } from '../canvas/nodes/infraIcons'
import type { InfraService } from '../../shared/types'
import { DialogActions, DialogButton, DialogError, DialogForm, DialogFrame, DialogTitle } from './ui/DialogPrimitives'

interface InfraDialogProps {
  isOpen: boolean
  onClose: () => void
}

// Add-infra dialog — a searchable registry picker (INFRA_LAYER_PLAN.md Phase I1).
// Pick a service (aws/rds, openai/api, ...) or a generic category node the
// user can assign to a concrete service later.
export function InfraDialog({ isOpen, onClose }: InfraDialogProps) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<InfraService | null>(null)
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const { services, loaded, fetchRegistry } = useRegistryStore()

  useEffect(() => {
    if (isOpen && !loaded) void fetchRegistry()
  }, [isOpen, loaded, fetchRegistry])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? services.filter(s =>
          s.name.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          s.provider.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q))
      : services
    // Generic fallbacks last — branded services are the common pick.
    return [...list].sort((a, b) =>
      Number(a.provider === 'generic') - Number(b.provider === 'generic'))
  }, [services, query])

  if (!isOpen) return null

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selected) {
      setError('Pick a service')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('http://127.0.0.1:7743/api/infra', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          service: selected.id,
          name: name.trim() || selected.name,
          createdBy: 'user',
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      // Canvas updates via the infra:upserted WebSocket patch.
      setQuery('')
      setSelected(null)
      setName('')
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create infra node')
    } finally {
      setLoading(false)
    }
  }

  return (
    <DialogFrame width={480} backdropClassName="nowheel" onWheel={event => event.stopPropagation()}>
        <DialogTitle>
          Add Infrastructure
        </DialogTitle>

        <DialogForm onSubmit={handleCreate} gap={14}>
          {error && (
            <DialogError>
              {error}
            </DialogError>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, letterSpacing: '0.05em' }}>
              SERVICE
            </label>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search: postgres, s3, openai, stripe, queue…"
              className="glass-input"
              autoFocus
            />
            <div style={{
              height: 210,
              overflowY: 'auto',
              border: '1px solid var(--border-dim)',
              background: 'var(--bg-base)',
            }}>
              {!loaded && (
                <div style={{ padding: 14, fontSize: 12, color: 'var(--text-dim)' }}>Loading registry…</div>
              )}
              {loaded && filtered.length === 0 && (
                <div style={{ padding: 14, fontSize: 12, color: 'var(--text-dim)' }}>No services match "{query}"</div>
              )}
              {filtered.map(svc => {
                const officialIcon = officialServiceIcon(svc.id)
                const icon = brandIcon(svc.brand.icon)
                const accent = svc.brand.darkColor ?? svc.brand.color
                const isSel = selected?.id === svc.id
                return (
                  <button
                    key={svc.id}
                    type="button"
                    onClick={() => setSelected(svc)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      textAlign: 'left',
                      padding: '7px 10px',
                      background: isSel ? 'var(--bg-raised)' : 'transparent',
                      border: 'none',
                      borderLeft: `3px solid ${isSel ? accent : 'transparent'}`,
                      cursor: 'pointer',
                    }}
                  >
                    {officialIcon ? (
                      <img src={officialIcon} alt="" width={13} height={13} style={{ flexShrink: 0, objectFit: 'contain' }} />
                    ) : icon ? (
                      <svg viewBox="0 0 24 24" width={13} height={13} style={{ flexShrink: 0 }}>
                        <path d={icon.path} fill={accent} />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width={13} height={13} style={{ flexShrink: 0 }}>
                        <path d={CATEGORY_GLYPHS[svc.category] ?? CATEGORY_GLYPHS.api} fill={accent} />
                      </svg>
                    )}
                    <span style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 600 }}>
                      {svc.name}
                    </span>
                    <span style={{
                      fontSize: 9,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--text-dim)',
                      marginLeft: 'auto',
                      letterSpacing: '0.06em',
                    }}>
                      {svc.category.toUpperCase()}{svc.subtype ? ` · ${svc.subtype.toUpperCase()}` : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, letterSpacing: '0.05em' }}>
              NAME <span style={{ opacity: 0.5, fontWeight: 400 }}>(optional — defaults to the service name)</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={selected ? `e.g. "Primary ${selected.name}"` : 'e.g. "Primary DB", "Payments API"'}
              className="glass-input"
            />
          </div>

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
              disabled={loading || !selected}
              disabledOpacity={0.6}
              variant="primary"
            >
              {loading ? 'Adding…' : 'Add to Canvas'}
            </DialogButton>
          </DialogActions>
        </DialogForm>
    </DialogFrame>
  )
}
