import { useEffect, useMemo, useState } from 'react'
import { apiGetBranchCollisions, apiGetParallelCommandDeck } from '../canvas/arcdApi'
import { useGraphStore } from '../store/graphStore'
import type { ParallelAgentSnapshot, ParallelCommandDeckStatus } from '../../shared/types'
import { buildAgentLaneModel } from './agentLaneModel'

const REFRESH_MS = 4000

/** Shows live worktree ownership and pre-merge semantic collisions. */
export function AgentLane() {
  const workspaceId = useGraphStore(state => state.currentProject?.id ?? '')
  const setSelectedNode = useGraphStore(state => state.setSelectedNode)
  const setInspectedNode = useGraphStore(state => state.setInspectedNode)
  const [snapshot, setSnapshot] = useState<ParallelAgentSnapshot | null>(null)
  const [deck, setDeck] = useState<ParallelCommandDeckStatus | null>(null)
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    setSnapshot(null)
    setDeck(null)
    setExpanded(true)
    if (!workspaceId) return

    let disposed = false
    let request: AbortController | null = null
    const refresh = () => {
      request?.abort()
      request = new AbortController()
      const signal = request.signal
      void apiGetBranchCollisions(workspaceId, signal)
        .then(next => { if (!disposed) setSnapshot(next) })
        .catch(error => {
          if (!disposed && error instanceof Error && error.name !== 'AbortError') {
            console.warn('[agent-lane] refresh failed:', error.message)
          }
        })
      void apiGetParallelCommandDeck(workspaceId, signal)
        .then(next => { if (!disposed) setDeck(next) })
        .catch(error => {
          if (!disposed && error instanceof Error && error.name !== 'AbortError') {
            console.warn('[agent-lane] briefing refresh failed:', error.message)
          }
        })
    }
    const refreshWhenVisible = () => { if (!document.hidden) refresh() }

    // Deferred, not immediate. Resolving these two fetches during the canvas's
    // first paint lands a render inside React Flow's initial fitView window and
    // moves the camera - the Floor came up framed differently depending on how
    // busy the main thread happened to be. This panel is background context;
    // it is never needed in the first frame, and the 4s refresh below makes one
    // deferred load free.
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(() => refresh(), { timeout: 1000 })
      : window.setTimeout(refresh, 250)
    const interval = window.setInterval(refreshWhenVisible, REFRESH_MS)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      disposed = true
      request?.abort()
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle)
      else window.clearTimeout(idle)
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [workspaceId])

  const model = useMemo(() => buildAgentLaneModel(snapshot, deck), [snapshot, deck])
  if (!model.visible) return null

  const focusSystem = (systemId: string) => {
    setSelectedNode(systemId)
    setInspectedNode(systemId)
  }
  const collisionLabel = model.collisions.length === 1 ? '1 collision' : `${model.collisions.length} collisions`

  return (
    <aside
      className="axiom-agent-lane"
      data-colliding={model.collisions.length > 0 || undefined}
      aria-label="Parallel branches and agents"
    >
      <button
        type="button"
        className="axiom-agent-lane__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
      >
        <span className="axiom-agent-lane__signal" aria-hidden="true" />
        <span className="axiom-agent-lane__heading">
          <strong>Parallel work</strong>
          <span>{model.branchCount} branches · {model.agentCount} agent{model.agentCount === 1 ? '' : 's'}</span>
        </span>
        {model.collisions.length > 0 && (
          <span className="axiom-agent-lane__collision-count">{collisionLabel}</span>
        )}
        <span className="axiom-agent-lane__chevron" aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="axiom-agent-lane__body">
          <section className="axiom-agent-lane__section" aria-labelledby="axiom-agent-branches">
            <h2 id="axiom-agent-branches">Worktrees</h2>
            <div className="axiom-agent-lane__branches">
              {model.branches.map(branch => (
                <article className="axiom-agent-branch" key={branch.rootId}>
                  <header>
                    <span className="axiom-agent-branch__name" title={branch.name}>{branch.name}</span>
                    {branch.isPrimary && <span className="axiom-agent-branch__primary">primary</span>}
                    <code>{branch.head}</code>
                  </header>
                  <div className="axiom-agent-branch__work">
                    {branch.agents.length === 0 ? (
                      <span className="axiom-agent-branch__idle">No agent reporting</span>
                    ) : branch.agents.map(agent => (
                      <div className="axiom-agent-branch__agent" key={agent.id} title={agent.goal}>
                        <span aria-hidden="true" />
                        <strong>{agent.name}</strong>
                        <p>{agent.goal}</p>
                      </div>
                    ))}
                  </div>
                  <footer>
                    <span>{branch.boundaryCount} boundar{branch.boundaryCount === 1 ? 'y' : 'ies'}</span>
                    <span>{branch.fileCount} changed file{branch.fileCount === 1 ? '' : 's'}</span>
                    {branch.errorCount > 0 && <span className="axiom-agent-branch__warning">git unavailable</span>}
                  </footer>
                  {(branch.unreviewed > 0 || branch.unexplained > 0 || branch.unexpected > 0) && (
                    <div className="axiom-agent-branch__brief" aria-label={`${branch.name} review status`}>
                      {branch.unreviewed > 0 && <span>{branch.unreviewed} unreviewed</span>}
                      {branch.unexplained > 0 && <span data-warning>{branch.unexplained} unexplained</span>}
                      {branch.unexpected > 0 && <span data-danger>{branch.unexpected} unexpected</span>}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section
            className="axiom-agent-lane__section axiom-agent-lane__collisions"
            aria-labelledby="axiom-agent-collisions"
            aria-live="polite"
          >
            <h2 id="axiom-agent-collisions">Semantic collisions</h2>
            {model.collisions.length === 0 ? (
              <p className="axiom-agent-lane__clear">No shared boundaries in the active branches.</p>
            ) : model.collisions.map(collision => (
              <button
                type="button"
                className="axiom-agent-collision"
                key={collision.systemId}
                onClick={() => focusSystem(collision.systemId)}
                title={`Show ${collision.systemName} on the map`}
              >
                <span className="axiom-agent-collision__system">{collision.systemName}</span>
                <span className="axiom-agent-collision__route">
                  {collision.branches.map(branch => branch.name).join(' × ')}
                </span>
                <span className="axiom-agent-collision__details">
                  {collision.branches.map(branch => (
                    <span key={branch.rootId}>
                      <strong>{branch.name}</strong> · {branch.claim}
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </section>
        </div>
      )}
    </aside>
  )
}
