// PlannedNode — authored UML for code that doesn't exist yet (REVISION 2).
// The node IS the editor: type the name inline on creation, double-click to
// rename, add members in the compartment's trailing row, pick a color from
// the swatch strip when selected. No dialogs.
//
// Semantic shapes (research-backed small set — the C4 "shape zoos don't
// scale" lesson, minus its all-rectangles absolutism):
//   box      class/file — the universal compartment box
//   folder   system/package — UML package tab
//   cylinder data store — universally recognized
//   hexagon  service/API — the modern microservice convention
// Dashed = planned, solid = realized; members turn green as reality arrives.
import React, { useEffect, useRef, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../../store/graphStore'
import { useSheetStore, plannedMembers, type PlannedNode as PlannedModel } from '../../store/sheetStore'
import { NodeShell } from './NodeShell'
import { CompartmentBody } from './CompartmentBody'

// Curated drafting accents — matches the depth palette in global.css.
export const PLAN_COLORS = ['#5B8A9A', '#C4956A', '#7A9E7E', '#A07B8A', '#D4A843', '#8A94A6']

const STATUS_COLOR: Record<string, string> = {
  planned: 'var(--text-dim)',
  partial: 'var(--warn)',
  realized: 'var(--ok)',
  flattened: 'var(--ok)',
}

export function shapeFor(p: { shape: string; kind: string }): 'box' | 'classbox' | 'folder' | 'cylinder' | 'hexagon' {
  if (p.shape && p.shape !== 'box') return p.shape as ReturnType<typeof shapeFor>
  if (p.kind === 'system') return 'folder'
  // Planned classes wear the same chamfered classbox as realized ones — the
  // shape survives realization unchanged (only dashed→solid flips).
  if (p.kind === 'class') return 'classbox'
  return 'box'
}

export function PlannedUmlNode({ data, selected }: NodeProps) {
  const p = (data as { planned: PlannedModel }).planned
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const { updatePlanned, deletePlanned, setPlannedApproval, lastCreatedPlannedId } = useSheetStore(useShallow(s => ({
    updatePlanned: s.updatePlanned, deletePlanned: s.deletePlanned,
    setPlannedApproval: s.setPlannedApproval,
    lastCreatedPlannedId: s.lastCreatedPlannedId,
  })))
  const members = plannedMembers(p)
  const done = members.filter(m => m.realized).length
  const isRealized = p.status === 'realized' || p.status === 'flattened'
  const proposalPending = p.createdBy === 'agent' && p.approvalStatus === 'pending'
  const rejected = p.approvalStatus === 'rejected'
  const statusColor = rejected ? 'var(--error)' : (STATUS_COLOR[p.status] ?? 'var(--text-dim)')
  const accent = rejected ? 'var(--error)' : proposalPending ? 'var(--warn)' : (p.color || 'var(--accent)')
  const shape = shapeFor(p)

  const [editingName, setEditingName] = useState(false)
  const [editingPath, setEditingPath] = useState(false)
  const [newMember, setNewMember] = useState('')
  const [approvalBusy, setApprovalBusy] = useState(false)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  // Freshly dropped from the palette → straight into the name editor.
  useEffect(() => {
    if (lastCreatedPlannedId === p.id) setEditingName(true)
  }, [lastCreatedPlannedId, p.id])
  useEffect(() => {
    if (editingName) nameRef.current?.select()
  }, [editingName])

  const commit = (patch: Partial<PlannedModel>) =>
    void updatePlanned(workspaceId, { ...p, ...patch })

  const addMember = () => {
    const sig = newMember.trim()
    if (!sig) return
    commit({ members: [...members, { signature: sig, realized: false }] })
    setNewMember('')
  }
  const removeMember = (i: number) =>
    commit({ members: members.filter((_, idx) => idx !== i) })

  const stopAll = { onMouseDown: (e: React.MouseEvent) => e.stopPropagation() }
  const decideProposal = async (decision: 'approved' | 'rejected') => {
    if (approvalBusy) return
    setApprovalBusy(true)
    setApprovalError(null)
    try {
      await setPlannedApproval(workspaceId, p.id, decision)
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : 'Unable to resolve proposal')
    } finally {
      setApprovalBusy(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-base)', border: `1px solid ${accent}`, color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)', fontSize: 12, padding: '2px 5px', width: '100%',
  }

  const body = (
    <>
      {proposalPending && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '5px 8px',
            borderBottom: '1px dashed var(--warn)', background: 'color-mix(in srgb, var(--warn) 10%, transparent)',
          }}
          {...stopAll}
        >
          <span style={{ fontSize: 8, fontWeight: 800, color: 'var(--warn)', letterSpacing: '0.08em' }}>
            AGENT PROPOSAL
          </span>
          <button
            type="button"
            disabled={approvalBusy}
            onClick={e => { e.stopPropagation(); void decideProposal('approved') }}
            style={{ marginLeft: 'auto', fontSize: 8, cursor: 'pointer' }}
          >
            Confirm
          </button>
          <button
            type="button"
            disabled={approvalBusy}
            onClick={e => { e.stopPropagation(); void decideProposal('rejected') }}
            style={{ fontSize: 8, cursor: 'pointer' }}
          >
            Reject
          </button>
        </div>
      )}
      {rejected && (
        <div style={{ padding: '4px 8px', borderBottom: '1px dashed var(--error)', color: 'var(--error)', fontSize: 8, fontWeight: 800 }}>
          REJECTED PROPOSAL
        </div>
      )}
      {approvalError && (
        <div style={{ padding: '3px 8px', color: 'var(--error)', fontSize: 8 }}>{approvalError}</div>
      )}
      {/* header compartment */}
      <div style={{ padding: '7px 10px', borderBottom: members.length > 0 || !isRealized ? '1px solid var(--border-dim)' : 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontSize: 7.5, fontWeight: 700, letterSpacing: '0.08em',
            color: statusColor, border: `1px ${isRealized ? 'solid' : 'dashed'} ${statusColor}`,
            padding: '1px 4px', lineHeight: 1.4, flexShrink: 0,
          }}>
            {p.status === 'partial' ? `${done}/${members.length}` : p.status.toUpperCase()}
          </span>
          {editingName ? (
            <input
              ref={nameRef} defaultValue={p.name} style={inputStyle} {...stopAll}
              onBlur={e => { setEditingName(false); if (e.target.value.trim()) commit({ name: e.target.value.trim() }) }}
              onKeyDown={e => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditingName(false)
              }}
            />
          ) : (
            <span
              onDoubleClick={() => setEditingName(true)}
              title="Double-click to rename"
              style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', cursor: 'text' }}
            >{p.name}</span>
          )}
          <button
            title="Delete"
            onClick={(e) => { e.stopPropagation(); void deletePlanned(workspaceId, p.id) }}
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 11, padding: 0 }}
          >×</button>
        </div>
        {editingPath ? (
          <input
            autoFocus defaultValue={p.declaredPath} placeholder="src/services/auth.ts"
            style={{ ...inputStyle, fontSize: 9.5, marginTop: 3 }} {...stopAll}
            onBlur={e => { setEditingPath(false); commit({ declaredPath: e.target.value.trim() }) }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingPath(false) }}
          />
        ) : (
          <div
            onDoubleClick={() => setEditingPath(true)}
            title="Double-click to set the target path (where the agent should build this)"
            style={{ fontSize: 9, color: p.declaredPath ? 'var(--text-secondary)' : 'var(--text-dim)', marginTop: 3, cursor: 'text', fontStyle: p.declaredPath ? 'normal' : 'italic' }}
          >{p.declaredPath || 'set target path…'}</div>
        )}
      </div>

      {/* member compartment — inline add, no dialogs */}
      {(shape === 'box' || shape === 'hexagon' || shape === 'cylinder') && (
        <div style={{ padding: '5px 10px 7px' }}>
          <CompartmentBody rows={members.map((m, i) => ({
            icon: m.realized ? 'realized' as const : 'pending' as const,
            label: m.signature,
            title: m.intent,
            onRemove: () => removeMember(i),
          }))} />
          {!isRealized && (
            <input
              value={newMember} placeholder="+ add member, e.g. login(email)"
              {...stopAll}
              onChange={e => setNewMember(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addMember() }}
              onBlur={addMember}
              style={{
                background: 'transparent', border: 'none', borderTop: members.length ? '1px dashed var(--border-dim)' : 'none',
                color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 10,
                padding: '4px 0 0', width: '100%', outline: 'none', marginTop: members.length ? 3 : 0,
              }}
            />
          )}
        </div>
      )}
    </>
  )

  return (
    <div>
      <NodeShell shape={shape} accent={accent} dashed={!isRealized} selected={selected}>
        {body}
      </NodeShell>
      {p.notes && (
        <div style={{ padding: '3px 2px 0', fontSize: 9, color: 'var(--text-dim)', fontStyle: 'italic', maxWidth: 300 }}>{p.notes}</div>
      )}
      {/* color swatches — visible while selected */}
      {selected && (
        <div style={{ display: 'flex', gap: 4, marginTop: 5 }} {...stopAll}>
          {PLAN_COLORS.map(c => (
            <button
              key={c}
              onClick={(e) => { e.stopPropagation(); commit({ color: c }) }}
              style={{
                width: 13, height: 13, background: c, cursor: 'pointer',
                border: p.color === c ? '2px solid var(--text-primary)' : '1px solid var(--border)',
              }}
            />
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right}  id="s" style={{ width: 8, height: 8, background: accent }} />
      <Handle type="target" position={Position.Left}   id="t" style={{ width: 8, height: 8, background: accent }} />
      <Handle type="source" position={Position.Bottom} id="sb" style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top}    id="tt" style={{ opacity: 0 }} />
    </div>
  )
}
