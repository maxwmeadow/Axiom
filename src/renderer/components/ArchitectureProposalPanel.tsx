import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import { useProposalStore } from '../store/architectureProposalStore.ts'
import {
  blockedReason,
  buildProposalTree,
  describeProgress,
  readProgress,
  type ProposalNode,
} from '../canvas/architectureProposal.ts'
import { raiseInvitation, resolveInterruption } from '../store/interruptionStore.ts'

/**
 * Reviewing the architecture an agent proposed for this codebase.
 *
 * A docked rail rather than a modal, and the same keyboard triage as the
 * Morning Delta — j/k to move, Enter to approve, R to send back, Escape to
 * leave — because reviewing forty systems should never require the mouse, and
 * because a second review surface that behaved differently would be a second
 * thing to learn.
 *
 * The panel shows a TREE, not a list. A flat list of forty names is the
 * failure this whole feature exists to fix: what makes an architecture
 * legible is that Living Architecture Canvas contains Semantic Zoom contains
 * Node Rendering, and you can hold twelve things in your head only when the
 * other sixty are folded inside them.
 */

const INVITATION = 'architecture-proposal'

export function ArchitectureProposalPanel() {
  const workspaceId = useGraphStore(state => state.currentProject?.id ?? '')
  const {
    proposal, reviewing, cursor, refusals, deciding, error,
    load, decide, beginReview, endReview, setCursor,
  } = useProposalStore(useShallow(state => ({
    proposal: state.proposal,
    reviewing: state.reviewing,
    cursor: state.cursor,
    refusals: state.refusals,
    deciding: state.deciding,
    error: state.error,
    load: state.load,
    decide: state.decide,
    beginReview: state.beginReview,
    endReview: state.endReview,
    setCursor: state.setCursor,
  })))

  const [rejecting, setRejecting] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const listRef = useRef<HTMLOListElement>(null)

  useEffect(() => { void load(workspaceId) }, [workspaceId, load])

  const systems = proposal?.systems ?? []
  const bySystemKey = useMemo(
    () => new Map(systems.map(system => [system.systemKey, system])),
    [systems],
  )
  const tree = useMemo(() => buildProposalTree(systems), [systems])
  const progress = useMemo(() => readProgress(systems), [systems])

  // Flattened in display order so j/k walks what the eye walks, rather than
  // the order the daemon happened to return.
  const ordered = useMemo(() => {
    const out: Array<{ node: ProposalNode; depth: number }> = []
    const walk = (nodes: ProposalNode[], depth: number) => {
      for (const node of nodes) {
        out.push({ node, depth })
        walk(node.children, depth + 1)
      }
    }
    walk(tree, 0)
    return out
  }, [tree])

  const active = Math.min(cursor, Math.max(ordered.length - 1, 0))

  const approve = useCallback((systemKey: string) => {
    void decide(systemKey, 'approved')
  }, [decide])

  const sendBack = useCallback((systemKey: string) => {
    if (!reason.trim()) return
    void decide(systemKey, 'rejected', reason.trim())
    setRejecting(null)
    setReason('')
  }, [decide, reason])

  // Keyboard triage, matching the Morning Delta so there is one way to review.
  useEffect(() => {
    if (!reviewing) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        if (event.key === 'Escape') { setRejecting(null); setReason('') }
        return
      }
      const current = ordered[active]?.node
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        setCursor(Math.min(active + 1, ordered.length - 1))
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        setCursor(Math.max(active - 1, 0))
      } else if (event.key === 'Enter' && current) {
        event.preventDefault()
        approve(current.systemKey)
      } else if ((event.key === 'r' || event.key === 'R') && current) {
        event.preventDefault()
        setRejecting(current.systemKey)
        setReason('')
      } else if (event.key === 'Escape') {
        endReview()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reviewing, active, ordered, setCursor, endReview, approve])

  useEffect(() => {
    if (!reviewing) return
    const node = listRef.current?.children[active] as HTMLElement | undefined
    node?.scrollIntoView({ block: 'nearest' })
  }, [reviewing, active])

  // The offer to review is a tenant of the interruption lane, like every other
  // thing that wants attention. It never opens itself: an agent finishing a
  // proposal while you are mid-thought must not seize the screen.
  const waiting = Boolean(proposal) && !reviewing && progress.pending > 0
  useEffect(() => {
    if (!waiting || !proposal) {
      resolveInterruption(INVITATION)
      return
    }
    raiseInvitation(
      INVITATION,
      'An agent has proposed an architecture',
      describeProgress(progress),
      [{ label: 'Review it', primary: true, run: () => beginReview() }],
    )
  }, [waiting, proposal, progress.pending, beginReview])

  if (!reviewing || !proposal) return null

  return (
    <aside className="axiom-proposal axiom-proposal--panel" aria-label="Proposed architecture">
      <header className="axiom-proposal__header">
        <span className="axiom-proposal__mode">Proposed architecture</span>
        <span className="axiom-proposal__progress">{describeProgress(progress)}</span>
        <button type="button" className="axiom-proposal__close" onClick={endReview} aria-label="Close review">
          ×
        </button>
      </header>

      {proposal.rationale && (
        <p className="axiom-proposal__rationale">{proposal.rationale}</p>
      )}
      {error && <p className="axiom-proposal__error">{error}</p>}

      <ol className="axiom-proposal__list" ref={listRef}>
        {ordered.map(({ node, depth }, index) => {
          const blocked = blockedReason(node, bySystemKey)
          const refusal = refusals[node.systemKey]
          const busy = deciding.includes(node.systemKey)
          return (
            <li
              key={node.systemKey}
              className="axiom-proposal__item"
              data-active={index === active || undefined}
              data-decision={node.decision}
              style={{ paddingLeft: `${12 + depth * 16}px` }}
              onClick={() => setCursor(index)}
            >
              <div className="axiom-proposal__row">
                <span className="axiom-proposal__name">{node.name}</span>
                <span className="axiom-proposal__count">
                  {node.fileCount} {node.fileCount === 1 ? 'file' : 'files'}
                </span>
              </div>

              {node.description && (
                <p className="axiom-proposal__purpose">{node.description}</p>
              )}

              {node.decision === 'rejected' && node.rejectionReason && (
                <p className="axiom-proposal__sentback">Sent back: {node.rejectionReason}</p>
              )}

              {node.decision === 'pending' && rejecting === node.systemKey && (
                <div className="axiom-proposal__reject">
                  <textarea
                    autoFocus
                    value={reason}
                    placeholder="What is wrong with it? The agent uses this to try again."
                    onChange={event => setReason(event.target.value)}
                  />
                  <div className="axiom-proposal__reject-actions">
                    <button type="button" onClick={() => { setRejecting(null); setReason('') }}>Cancel</button>
                    <button type="button" disabled={!reason.trim()} onClick={() => sendBack(node.systemKey)}>
                      Send back
                    </button>
                  </div>
                </div>
              )}

              {node.decision === 'pending' && rejecting !== node.systemKey && (
                <div className="axiom-proposal__actions">
                  <button
                    type="button"
                    className="axiom-proposal__approve"
                    disabled={busy}
                    onClick={() => approve(node.systemKey)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { setRejecting(node.systemKey); setReason('') }}
                  >
                    Send back
                  </button>
                </div>
              )}

              {/* A refusal is a sentence next to the control, never a disabled
                  button that explains nothing. */}
              {(refusal || blocked) && node.decision === 'pending' && (
                <p className="axiom-proposal__refusal">{refusal || blocked}</p>
              )}
            </li>
          )
        })}
      </ol>

      <footer className="axiom-proposal__footer">
        <span>J K move · Enter approve · R send back · Esc leave</span>
      </footer>
    </aside>
  )
}
