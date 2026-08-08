import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import {
  buildDeltaReview,
  claimRationale,
  clampClaimCursor,
  deltaAttribution,
  deltaHeadline,
  deltaWindow,
  realizationPresentation,
  sessionDuration,
  type DeltaReview,
} from '../canvas/deltaReview.ts'
import type { DeltaClaim } from '../../shared/types'
import { raiseInvitation, resolveInterruption } from '../store/interruptionStore.ts'

/** One id, so a refreshed delta replaces its invitation instead of stacking. */
const DELTA_INVITATION = 'delta-review'

/**
 * Morning Delta review panel.
 *
 * This replaced a horizontal scrubber, and the difference is not decoration.
 * A scrubber says "here is item 4 of 10" — you cannot see the shape of the
 * work, cannot skip what you don't care about, and cannot read a path in the
 * space available. Review is triage, not playback: you want the whole list at
 * once, ranked, with room for the actual names of things.
 *
 * Every row states an architectural claim in plain language. Its evidence
 * (call sites, files) is folded away until asked for, so a delta with 200
 * underlying changes still reads as a handful of statements.
 */

const KIND_TONE: Record<string, string> = {
  'system.coupling': 'coupling',
  'system.decoupling': 'decoupling',
  'system.hub': 'coupling',
  'system.orphaned': 'decoupling',
  'system.added': 'structural',
  'system.removed': 'structural',
  'system.membership': 'membership',
  'file.unclassified': 'pending',
  'system.internal': 'internal',
}

function actorBadge(actor: string): string {
  if (actor === 'agent') return 'AGENT'
  if (actor === 'both') return 'BOTH'
  return 'YOU'
}

function ClaimRow({
  claim, review, active, expanded, onSelect, onToggle,
}: {
  claim: DeltaClaim
  review: DeltaReview
  active: boolean
  expanded: boolean
  onSelect: () => void
  onToggle: () => void
}) {
  const evidence = [...(claim.realizationEvidence ?? []), ...claim.evidence]
  const hasEvidence = evidence.length > 0
  const realization = claim.realizationState
    ? realizationPresentation(claim.realizationState)
    : null
  // Topology says what moved; only the agent that moved it can say why. When
  // nobody narrated the change, say so rather than leaving a silent gap.
  const why = claimRationale(claim, review)
  return (
    <li
      className="axiom-delta__claim"
      data-tone={KIND_TONE[claim.kind] ?? 'structural'}
      data-active={active || undefined}
      data-cycle={claim.createsCycle || undefined}
      aria-current={active ? 'true' : undefined}
    >
      <button type="button" className="axiom-delta__claim-head" onClick={onSelect}>
        <span className="axiom-delta__claim-title">
          {claim.createsCycle && <span className="axiom-delta__cycle">CYCLE</span>}
          {claim.title}
        </span>
        {why && <span className="axiom-delta__claim-why">“{why}”</span>}
        <span className="axiom-delta__claim-meta">
          <span className="axiom-delta__claim-sub">{claim.subtitle}</span>
          {claim.realizationState && realization && (
            <span
              className="axiom-delta__intent"
              data-status={claim.realizationState.toLowerCase()}
              title={realization.title}
            >
              {realization.label}
            </span>
          )}
          {!why && claim.actor === 'agent' && (
            <span className="axiom-delta__unexplained" title="No agent narrated this change">
              UNEXPLAINED
            </span>
          )}
          <span className="axiom-delta__actor" data-actor={claim.actor}>{actorBadge(claim.actor)}</span>
        </span>
      </button>

      {hasEvidence && (
        <button
          type="button"
          className="axiom-delta__evidence-toggle"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? '▾' : '▸'} {evidence.length} evidence
        </button>
      )}

      {expanded && hasEvidence && (
        <ul className="axiom-delta__evidence">
          {evidence.map((item, index) => (
            <li key={`${claim.id}:${index}`}>
              <span className="axiom-delta__evidence-label">{item.label}</span>
              {item.detail && <span className="axiom-delta__evidence-detail">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

export function DeltaPanel() {
  const { delta, reviewing, cursor, deferredUntil, files, systems, startReview, setCursor, deferDelta, endReview } =
    useGraphStore(useShallow(state => ({
      delta: state.delta,
      reviewing: state.deltaReviewing,
      cursor: state.deltaCursor,
      deferredUntil: state.deltaDeferredUntil,
      files: state.files,
      systems: state.systems,
      startReview: state.startDeltaReview,
      setCursor: state.setDeltaCursor,
      deferDelta: state.deferDelta,
      endReview: state.endDeltaReview,
    })))

  const [showInternal, setShowInternal] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const listRef = useRef<HTMLOListElement>(null)

  const knownNodeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const file of files) ids.add(file.id)
    for (const system of systems) ids.add(system.id)
    return ids
  }, [files, systems])

  const review = useMemo(() => buildDeltaReview(delta, knownNodeIds), [delta, knownNodeIds])
  const visible = useMemo(
    () => (showInternal ? [...review.claims, ...review.internalClaims] : review.claims),
    [review, showInternal],
  )
  const active = clampClaimCursor(visible, cursor)

  const toggleEvidence = useCallback((id: string) => {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Keyboard triage, borrowed from PR review: j/k to move, Enter to expand,
  // Escape to leave. Reviewing fifty claims should never require the mouse.
  useEffect(() => {
    if (!reviewing) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.isContentEditable)) return
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        setCursor(Math.min(active + 1, visible.length - 1))
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        setCursor(Math.max(active - 1, 0))
      } else if (event.key === 'Enter' && visible[active]) {
        event.preventDefault()
        toggleEvidence(visible[active].id)
      } else if (event.key === 'Escape') {
        endReview(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reviewing, active, visible, setCursor, endReview, toggleEvidence])

  // Keep the active claim in view when moving by keyboard.
  useEffect(() => {
    if (!reviewing || active < 0) return
    const node = listRef.current?.children[active] as HTMLElement | undefined
    node?.scrollIntoView({ block: 'nearest' })
  }, [reviewing, active])

  // The invitation to review lives in the interruption lane, not beside it.
  // It used to be a strip at top-centre — the same coordinates the lane now
  // occupies, so the two covered each other exactly like the banners this was
  // supposed to have fixed. One surface owns that space; this is a tenant.
  const pending = Boolean(delta) && !review.empty && !reviewing &&
    deferredUntil !== delta?.until
  useEffect(() => {
    if (!pending || !delta) {
      resolveInterruption(DELTA_INVITATION)
      return
    }
    // No "Later" button: the × beside it already means exactly that, and two
    // controls for one gesture invited the reading that they differ. Dismissal
    // now records the deferral, which is what keeps the delta unreviewed in
    // archd and puts the way back into the status bar.
    raiseInvitation(
      DELTA_INVITATION,
      deltaHeadline(review),
      `${deltaWindow(delta.since, delta.until)} · ${deltaAttribution(delta.counts)}`,
      [{ label: 'Review', primary: true, run: startReview }],
      deferDelta,
      'Set aside — stays unreviewed, reopen from the status bar',
    )
  }, [pending, delta, review, startReview, deferDelta])

  // Only the expanded review renders here now; the invitation is a lane tenant.
  if (!delta || review.empty || !reviewing) return null

  return (
    <aside className="axiom-delta axiom-delta--panel" aria-label="Reviewing changes">
      <header className="axiom-delta__header">
        <span className="axiom-delta__mode">Delta</span>
        <div className="axiom-delta__identity">
          <strong>{deltaHeadline(review)}</strong>
          <span>{deltaWindow(delta.since, delta.until)} · {deltaAttribution(delta.counts)}</span>
        </div>
        <button
          type="button"
          className="axiom-delta__close"
          aria-label="Close review, keep the delta"
          onClick={() => endReview(false)}
        >
          ×
        </button>
      </header>

      {review.sessionList.length > 0 && (
        <ol className="axiom-delta__sessions" aria-label="What the agents said they were doing">
          {review.sessionList.map(session => (
            <li key={session.id} className="axiom-delta__session">
              <span className="axiom-delta__session-goal">{session.goal}</span>
              <span className="axiom-delta__session-meta">
                <span className="axiom-delta__actor" data-actor="agent">
                  {(session.agent || 'agent').toUpperCase()}
                </span>
                {sessionDuration(session)}
                {session.endedAt === 0 && ' · still working'}
              </span>
              {session.summary && (
                <span className="axiom-delta__session-summary">{session.summary}</span>
              )}
              {session.notes.length > 0 && (
                <ul className="axiom-delta__session-notes">
                  {session.notes.map((note, index) => (
                    <li key={`${session.id}:${index}`}>— {note.text}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}

      <ol className="axiom-delta__claims" ref={listRef}>
        {visible.map((claim, index) => (
          <ClaimRow
            key={claim.id}
            claim={claim}
            review={review}
            active={index === active}
            expanded={expanded.has(claim.id)}
            onSelect={() => setCursor(index)}
            onToggle={() => toggleEvidence(claim.id)}
          />
        ))}
      </ol>

      <footer className="axiom-delta__footer">
        {review.internalClaims.length > 0 && (
          <button
            type="button"
            className="axiom-delta__reveal"
            aria-pressed={showInternal}
            onClick={() => setShowInternal(value => !value)}
          >
            {showInternal ? 'Hide' : 'Show'} {review.internalClaims.length} internal change
            {review.internalClaims.length > 1 ? 's' : ''}
          </button>
        )}
        <div className="axiom-delta__footer-actions">
          <kbd className="axiom-delta__hint">J / K</kbd>
          <button
            type="button"
            className="axiom-delta__button axiom-delta__button--primary"
            title="Mark this delta reviewed"
            onClick={() => endReview(true)}
          >
            Accept all
          </button>
        </div>
      </footer>
    </aside>
  )
}
