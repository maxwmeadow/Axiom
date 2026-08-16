import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectConfig } from '../../shared/types'
import type { AgentHostInfo, AgentInstallResult } from '../../../electron/preload'
import { AgentMascot } from '../components/AgentMascot'
import { WorkbenchTitleBar } from '../components/ui/WorkbenchTitleBar'
import { commandKind, presentAgentHost } from './connectAgentPresentation'

const POLL_MS = 2000

type Phase = 'waiting' | 'connected' | 'proposed'
type SetupStep = 1 | 2 | 3 | 4

interface AgentPresenceResponse {
  connected: boolean
  connections: Array<{ connectionId: string; hostId: string; lastSeenAt: number }>
}

interface Props {
  project: ProjectConfig
  fileCount: number
  indexing: boolean
  blankProject: boolean
  onComplete: () => void
  onReview: () => void
  onSkip: () => void
  onBack: () => void
}

const BLANK_PROJECT_STEPS: Array<{ id: SetupStep; label: string }> = [
  { id: 1, label: 'Add Axiom' },
  { id: 2, label: 'Connect' },
]

const CODEBASE_STEPS: Array<{ id: SetupStep; label: string }> = [
  { id: 1, label: 'Add Axiom' },
  { id: 2, label: 'Restart' },
  { id: 3, label: 'Map project' },
  { id: 4, label: 'Review' },
]

const progress = new Map<string, Phase>()

export function ConnectAgentScreen({
  project, fileCount, indexing, blankProject, onComplete, onReview, onSkip, onBack,
}: Props) {
  const [activeStep, setActiveStep] = useState<SetupStep>(1)
  const [copied, setCopied] = useState(false)
  const [hosts, setHosts] = useState<AgentHostInfo[]>([])
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, AgentInstallResult>>({})
  const [installing, setInstalling] = useState<string | null>(null)
  const [hasLivePresence, setHasLivePresence] = useState(false)
  const [liveHostIds, setLiveHostIds] = useState<Set<string>>(() => new Set())
  const [phase, setPhaseState] = useState<Phase>(() => progress.get(project.id) ?? 'waiting')
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const userSelectedHost = useRef(false)

  const setPhase = useCallback((next: Phase) => {
    const rank: Record<Phase, number> = { waiting: 0, connected: 1, proposed: 2 }
    const current = progress.get(project.id) ?? 'waiting'
    if (rank[next] <= rank[current]) return
    progress.set(project.id, next)
    setPhaseState(next)
  }, [project.id])

  const showHosts = useCallback((found: AgentHostInfo[]) => {
    const ordered = [...found].sort((left, right) =>
      Number(right.configured && right.workflowInstalled) - Number(left.configured && left.workflowInstalled) ||
      Number(right.detected) - Number(left.detected) ||
      left.label.localeCompare(right.label),
    )
    setHosts(ordered)
    setSelectedHostId(current => {
      if (current && ordered.some(host => host.id === current)) return current
      return ordered.find(host => host.configured && host.workflowInstalled)?.id
        ?? ordered.find(host => host.detected)?.id
        ?? ordered[0]?.id
        ?? null
    })
  }, [])

  useEffect(() => {
    void window.axiom.listAgentHosts(project.rootPath).then(showHosts)
    return () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }
  }, [project.rootPath, showHosts])

  useEffect(() => {
    if (userSelectedHost.current || liveHostIds.size === 0) return
    const liveHost = hosts.find(host => liveHostIds.has(host.id))
    if (liveHost) setSelectedHostId(liveHost.id)
  }, [hosts, liveHostIds])

  // A live presence response is the gate. Historical actions and installed
  // configuration prove earlier activity, not that an agent is listening now.
  useEffect(() => {
    const poll = async () => {
      const workspace = encodeURIComponent(project.id)
      if (!blankProject && phase !== 'proposed') {
        try {
          const res = await fetch(`http://127.0.0.1:7743/api/architecture-proposals?workspace=${workspace}`)
          if (res.ok) {
            const body = await res.json() as unknown
            const list = Array.isArray(body) ? body : (body as { proposals?: unknown[] })?.proposals ?? []
            if (list.length > 0) setPhase('proposed')
          }
        } catch { /* the next poll retries */ }
      }

      try {
        const res = await fetch(`http://127.0.0.1:7743/api/agent/presence?workspace=${workspace}`)
        if (res.ok) {
          const body = await res.json() as AgentPresenceResponse
          setHasLivePresence(body.connected)
          setLiveHostIds(new Set(
            (body.connections ?? []).map(item => item.hostId).filter(id => id !== 'unknown'),
          ))
          if (!blankProject && body.connected) setPhase('connected')
        }
      } catch { /* the next poll retries */ }

      if (!blankProject) {
        try {
          const res = await fetch(`http://127.0.0.1:7743/api/agent/actions?workspace=${workspace}&limit=200`)
          if (!res.ok) return
          const body = await res.json() as unknown
          const list = (Array.isArray(body) ? body : (body as { actions?: unknown[] })?.actions ?? []) as unknown[]
          if (list.length > 0) setPhase('connected')
        } catch { /* the next poll retries */ }
      }
    }

    void poll()
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [blankProject, phase, project.id, setPhase])

  const selectedHost = useMemo(
    () => hosts.find(host => host.id === selectedHostId) ?? null,
    [hosts, selectedHostId],
  )
  const mascotState = !blankProject && phase === 'proposed'
    ? 'proposal-ready'
    : hasLivePresence
      ? 'connected'
      : 'sleeping'
  const selectedPresentation = selectedHost
    ? presentAgentHost(selectedHost, results[selectedHost.id], liveHostIds.has(selectedHost.id))
    : null
  const selectedReady = selectedPresentation?.state === 'installed' || selectedPresentation?.state === 'live'
  const anyInstalled = hosts.some(host => {
    const state = presentAgentHost(host, results[host.id], liveHostIds.has(host.id)).state
    return state === 'installed' || state === 'live'
  })

  const chooseHost = (hostId: string) => {
    userSelectedHost.current = true
    setSelectedHostId(hostId)
  }

  const installHost = async (candidate: AgentHostInfo) => {
    setSelectedHostId(candidate.id)
    userSelectedHost.current = true
    setInstalling(candidate.id)
    try {
      const outcome = await window.axiom.installAgent(candidate.id, project.rootPath)
      setResults(current => ({ ...current, [candidate.id]: outcome }))
      if (outcome.ok) showHosts(await window.axiom.listAgentHosts(project.rootPath))
    } catch (error) {
      setResults(current => ({
        ...current,
        [candidate.id]: {
          ok: false,
          detail: error instanceof Error ? error.message : 'Axiom could not inspect the updated configuration.',
          paths: [],
        },
      }))
    } finally {
      setInstalling(null)
    }
  }

  const copyCommand = async () => {
    if (!selectedHost?.command) return
    try {
      await navigator.clipboard.writeText(selectedHost.command)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2200)
    } catch {
      setCopied(false)
    }
  }

  const stepComplete = (step: SetupStep) => {
    if (step === 1) return anyInstalled
    if (step === 2) return blankProject ? hasLivePresence : phase !== 'waiting'
    if (step === 3) return phase === 'proposed'
    return false
  }

  const stepLabels = blankProject ? BLANK_PROJECT_STEPS : CODEBASE_STEPS

  return (
    <div className="axiom-connect">
      <WorkbenchTitleBar
        className="axiom-connect__titlebar"
        context={`${project.name} / Agent Setup`}
        status={indexing ? 'INDEXING' : 'AGENT SETUP'}
        statusTone={indexing ? 'busy' : 'ready'}
      />

      <main className="axiom-connect__card">
        <header className="axiom-connect__header">
          <button type="button" className="axiom-connect__back" onClick={onBack}>← Projects</button>
          <div className="axiom-connect__identity">
            <div>
              <p className="axiom-connect__eyebrow">{project.name}</p>
              <h1>Bring an agent into Axiom</h1>
            </div>
            <span className="axiom-connect__indexed">
              {indexing ? 'Reading source…' : `${fileCount} source ${fileCount === 1 ? 'file' : 'files'}`}
            </span>
          </div>
        </header>

        <nav
          className="axiom-connect__step-nav"
          data-mode={blankProject ? 'blank' : 'codebase'}
          aria-label="Agent setup steps"
          role="tablist"
        >
          {stepLabels.map(step => (
            <button
              key={step.id}
              type="button"
              role="tab"
              aria-selected={activeStep === step.id}
              aria-controls="agent-setup-stage"
              data-state={stepComplete(step.id) ? 'done' : activeStep === step.id ? 'active' : 'idle'}
              onClick={() => setActiveStep(step.id)}
            >
              <span>{stepComplete(step.id) ? '✓' : step.id}</span>
              {step.label}
            </button>
          ))}
        </nav>

        <div className="axiom-connect__workspace">
          <section id="agent-setup-stage" className="axiom-connect__stage" role="tabpanel">
            {activeStep === 1 && (
              <div className="axiom-connect__step-panel">
                <p className="axiom-connect__step-kicker">Step 1 of {blankProject ? 2 : 4}</p>
                <h2>Add Axiom to your agent</h2>
                <p className="axiom-connect__step-copy">
                  {blankProject
                    ? 'Choose the agent you use. Axiom adds its MCP connection and the correct reusable workflow.'
                    : 'Choose the agent you use. Axiom adds its MCP connection and the correct reusable mapping workflow.'}
                </p>

                <ul className="axiom-connect__agents" aria-label="Supported agents">
                  {hosts.map(candidate => {
                    const presentation = presentAgentHost(
                      candidate,
                      results[candidate.id],
                      liveHostIds.has(candidate.id),
                    )
                    const isSelected = selectedHostId === candidate.id
                    const result = results[candidate.id]
                    return (
                      <li key={candidate.id} data-selected={isSelected} data-state={presentation.state}>
                        <label className="axiom-connect__agent-choice">
                          <input
                            type="radio"
                            name="axiom-agent"
                            value={candidate.id}
                            checked={isSelected}
                            onChange={() => chooseHost(candidate.id)}
                          />
                          <span
                            className="axiom-connect__host-signal"
                            data-state={presentation.state}
                            data-tooltip={presentation.detail}
                            tabIndex={0}
                            aria-label={`${candidate.label} status: ${presentation.detail}`}
                          />
                          <strong>{candidate.label}</strong>
                        </label>
                        {presentation.action !== 'none' && (
                          <button
                            type="button"
                            className="axiom-connect__install"
                            disabled={installing === candidate.id}
                            onClick={() => void installHost(candidate)}
                          >
                            {installing === candidate.id
                              ? 'Working…'
                              : presentation.action === 'install'
                                ? 'Install'
                                : presentation.action === 'repair'
                                  ? 'Repair'
                                  : 'Reinstall'}
                          </button>
                        )}
                        {result && isSelected && (
                          <p className="axiom-connect__install-result" data-ok={result.ok}>{result.detail}</p>
                        )}
                      </li>
                    )
                  })}
                </ul>

                <StepActions
                  nextLabel={selectedReady ? `Continue with ${selectedHost?.label}` : 'Continue'}
                  onNext={() => setActiveStep(2)}
                  nextDisabled={!selectedReady}
                />
              </div>
            )}

            {activeStep === 2 && blankProject && (
              <div className="axiom-connect__step-panel">
                <p className="axiom-connect__step-kicker">Step 2 of 2</p>
                <h2>Connect {selectedHost?.label ?? 'your agent'}</h2>
                {hasLivePresence ? (
                  <>
                    <p className="axiom-connect__step-copy">
                      {selectedHost?.label ?? 'Your agent'} is connected and Axiom is ready.
                    </p>
                    <div className="axiom-connect__waiting-line" data-state="connected" aria-live="polite">
                      <span aria-hidden="true" /> Live connection confirmed
                    </div>
                  </>
                ) : selectedReady ? (
                  <>
                    <p className="axiom-connect__step-copy">
                      Restart it and open a new session. Agents load MCP connections and workflows at startup.
                    </p>
                    <div className="axiom-connect__instruction-card">
                      <span aria-hidden="true">↻</span>
                      <p><strong>Start fresh.</strong> Keep Axiom open while the new agent session connects.</p>
                    </div>
                    <div className="axiom-connect__waiting-line" aria-live="polite">
                      <span aria-hidden="true" /> Waiting for a live agent
                    </div>
                  </>
                ) : (
                  <p className="axiom-connect__step-copy">
                    Select an available agent and finish installing Axiom before restarting it.
                  </p>
                )}
                <StepActions
                  backLabel="Back to agents"
                  onBack={() => setActiveStep(1)}
                  nextLabel="Open canvas"
                  onNext={onComplete}
                  nextDisabled={!hasLivePresence}
                />
              </div>
            )}

            {activeStep === 2 && !blankProject && (
              <div className="axiom-connect__step-panel">
                <p className="axiom-connect__step-kicker">Step 2 of 4</p>
                <h2>Restart {selectedHost?.label ?? 'your agent'}</h2>
                {selectedReady ? (
                  <>
                    <p className="axiom-connect__step-copy">
                      Close its existing session and open a new one. Agents load MCP connections and workflows at startup.
                    </p>
                    <div className="axiom-connect__instruction-card">
                      <span aria-hidden="true">↻</span>
                      <p><strong>Start fresh.</strong> Reopening only the chat is not enough in every harness; restart the agent application or CLI session.</p>
                    </div>
                  </>
                ) : (
                  <p className="axiom-connect__step-copy">
                    Select an available agent and finish installing Axiom before restarting it.
                  </p>
                )}
                <StepActions
                  backLabel="Back to agents"
                  onBack={() => setActiveStep(1)}
                  nextLabel="I restarted it"
                  onNext={() => setActiveStep(3)}
                />
              </div>
            )}

            {activeStep === 3 && !blankProject && (
              <div className="axiom-connect__step-panel">
                <p className="axiom-connect__step-kicker">Step 3 of 4</p>
                <h2>Ask {selectedHost?.label ?? 'your agent'} to map this project</h2>
                {selectedHost?.command ? (
                  <>
                    <p className="axiom-connect__step-copy">
                      {selectedReady ? 'In the new session, run' : 'Once Axiom is installed, run'} this {commandKind(selectedHost.command)} exactly as shown.
                    </p>
                    <div className="axiom-connect__command" data-kind={commandKind(selectedHost.command)}>
                      <span>{selectedHost.command}</span>
                      <button type="button" onClick={() => void copyCommand()}>{copied ? 'Copied ✓' : 'Copy'}</button>
                    </div>
                    <p className="axiom-connect__command-note">
                      The workflow carries Axiom’s mapping brief. You do not need to paste any extra prompt.
                    </p>
                  </>
                ) : (
                  <p className="axiom-connect__step-copy">
                    {selectedHost?.label ?? 'This agent'} is not ready yet. Return to step 1 and install or repair Axiom first.
                  </p>
                )}
                <StepActions
                  backLabel="Back"
                  onBack={() => setActiveStep(2)}
                  nextLabel="Continue to review"
                  onNext={() => setActiveStep(4)}
                />
              </div>
            )}

            {activeStep === 4 && !blankProject && (
              <div className="axiom-connect__step-panel">
                <p className="axiom-connect__step-kicker">Step 4 of 4</p>
                <h2>{phase === 'proposed' ? 'Your architecture is ready' : 'Wait for the proposal'}</h2>
                <p className="axiom-connect__step-copy">
                  {phase === 'proposed'
                    ? 'Your agent finished mapping the codebase. Review its systems, nesting, and file placement before anything becomes canonical.'
                    : hasLivePresence
                      ? `${selectedHost?.label ?? 'Your agent'} is connected and working. Axiom will light this step when the proposal arrives.`
                      : 'Keep Axiom open while the agent maps the project. You can return to any earlier step without losing progress.'}
                </p>
                {phase === 'proposed' ? (
                  <button type="button" className="axiom-connect__review" onClick={onReview}>Review architecture →</button>
                ) : (
                  <div className="axiom-connect__waiting-line" aria-live="polite">
                    <span aria-hidden="true" /> Waiting for a mapping proposal
                  </div>
                )}
                <StepActions backLabel="Back" onBack={() => setActiveStep(3)} />
              </div>
            )}
          </section>

          <aside className="axiom-connect__mascot">
            <AgentMascot state={mascotState} hostLabel={selectedHost?.label ?? 'agent'} />
          </aside>
        </div>

        {!blankProject && (
          <footer className="axiom-connect__footer">
            <span>Steps are always available; you can move back and forth at any time.</span>
            <button type="button" onClick={onSkip}>Open canvas without mapping</button>
          </footer>
        )}
      </main>
    </div>
  )
}

function StepActions({
  backLabel,
  onBack,
  nextLabel,
  onNext,
  nextDisabled = false,
}: {
  backLabel?: string
  onBack?: () => void
  nextLabel?: string
  onNext?: () => void
  nextDisabled?: boolean
}) {
  if (!onBack && !onNext) return null
  return (
    <div className="axiom-connect__step-actions">
      {onBack && <button type="button" className="axiom-connect__secondary" onClick={onBack}>{backLabel}</button>}
      {onNext && <button type="button" className="axiom-connect__primary" onClick={onNext} disabled={nextDisabled}>{nextLabel} →</button>}
    </div>
  )
}
