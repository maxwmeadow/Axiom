import React, { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import type { AgentAction, AgentActionKind } from '../../shared/types'

/**
 * The agent activity log.
 *
 * This is the "I can see everything my agent is doing" surface. It is not a
 * console dump: it groups by the work the agent declared it was doing, and
 * every row is a place on the map — clicking one takes the canvas there.
 *
 * Reads are shown, not filtered out. Watching an agent sweep through a region
 * before it writes anything is often the most informative part.
 */

const KIND_LABEL: Record<AgentActionKind, string> = {
  read: 'READ',
  trace: 'TRACE',
  write: 'EDIT',
  plan: 'PLAN',
  debug: 'DEBUG',
  narrate: 'NOTE',
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function ActionRow({
  action, onFocus,
}: {
  action: AgentAction
  onFocus: (targets: string[]) => void
}) {
  const focusable = action.targets.length > 0
  return (
    <li className="axiom-agentlog__row" data-kind={action.kind} data-status={action.status}>
      <button
        type="button"
        className="axiom-agentlog__entry"
        disabled={!focusable}
        title={focusable ? 'Show on the map' : undefined}
        onClick={() => onFocus(action.targets)}
      >
        <span className="axiom-agentlog__kind">{KIND_LABEL[action.kind]}</span>
        <span className="axiom-agentlog__summary">{action.summary}</span>
        <span className="axiom-agentlog__time">{timeOf(action.ts)}</span>
      </button>
      {action.status === 'error' && (
        <span className="axiom-agentlog__error" title={action.error}>{action.error}</span>
      )}
    </li>
  )
}

export function AgentLogPanel({ onClose }: { onClose: () => void }) {
  const { actions, sessions, loadAgentActions, setSelectedNode, setInspectedNode } =
    useGraphStore(useShallow(state => ({
      actions: state.agentActions,
      sessions: state.activeWorkSessions,
      loadAgentActions: state.loadAgentActions,
      setSelectedNode: state.setSelectedNode,
      setInspectedNode: state.setInspectedNode,
    })))

  const [kindFilter, setKindFilter] = useState<AgentActionKind | 'all'>('all')

  useEffect(() => { void loadAgentActions() }, [loadAgentActions])

  const visible = useMemo(
    () => (kindFilter === 'all' ? actions : actions.filter(a => a.kind === kindFilter)),
    [actions, kindFilter],
  )

  // Grouped by the work the agent declared. Ungrouped actions keep their own
  // bucket rather than being hidden — unexplained activity is worth seeing.
  const groups = useMemo(() => {
    const bySession = new Map<string, AgentAction[]>()
    for (const action of visible) {
      const key = action.sessionId || ''
      const bucket = bySession.get(key)
      if (bucket) bucket.push(action)
      else bySession.set(key, [action])
    }
    return [...bySession.entries()]
  }, [visible])

  const goalFor = (sessionId: string): string => {
    if (!sessionId) return 'Unattributed activity'
    return sessions.find(session => session.id === sessionId)?.goal ?? 'Earlier work'
  }

  const focus = (targets: string[]) => {
    if (targets.length === 0) return
    setSelectedNode(targets[0])
    setInspectedNode(targets[0])
  }

  return (
    <aside className="axiom-agentlog" aria-label="Agent activity log">
      <header className="axiom-agentlog__header">
        <span className="axiom-agentlog__mode">Agent</span>
        <div className="axiom-agentlog__identity">
          <strong>{actions.length} action{actions.length === 1 ? '' : 's'}</strong>
          <span>{sessions.length > 0 ? `${sessions.length} working now` : 'idle'}</span>
        </div>
        <button type="button" className="axiom-agentlog__close" aria-label="Close agent log" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="axiom-agentlog__filters" role="group" aria-label="Filter by kind">
        {(['all', 'read', 'trace', 'write', 'plan', 'debug'] as const).map(kind => (
          <button
            key={kind}
            type="button"
            className="axiom-agentlog__filter"
            aria-pressed={kindFilter === kind}
            data-active={kindFilter === kind || undefined}
            onClick={() => setKindFilter(kind)}
          >
            {kind}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="axiom-agentlog__empty">
          Nothing yet. Connect an agent through the Axiom MCP and its work appears here as it happens.
        </p>
      ) : (
        <div className="axiom-agentlog__scroll">
          {groups.map(([sessionId, entries]) => (
            <section key={sessionId || 'none'} className="axiom-agentlog__group">
              <h3 className="axiom-agentlog__goal" data-unattributed={!sessionId || undefined}>
                {goalFor(sessionId)}
              </h3>
              <ol className="axiom-agentlog__rows">
                {entries.map(action => (
                  <ActionRow key={action.id} action={action} onFocus={focus} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </aside>
  )
}
