import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectConfig } from '../../shared/types'
import type { AgentHostInfo, AgentInstallResult } from '../../../electron/preload'
import { WorkbenchTitleBar } from '../components/ui/WorkbenchTitleBar'
import { commandKind, presentAgentHost } from './connectAgentPresentation'

const POLL_MS = 2000

type Phase = 'waiting' | 'connected' | 'proposed'
type SetupStep = 1 | 2 | 3 | 4

interface AgentPresenceResponse {
  connected: boolean
  connections: Array<{ connectionId: string; hostId: string; lastSeenAt: number }>
}

// Connection progress is workspace state, not component state. The graph can
// remount onboarding while indexing; a proven connection must not disappear.
const progress = new Map<string, Phase>()

interface Props {
  project: ProjectConfig
  fileCount: number
  indexing: boolean
  onReview: () => void
  onSkip: () => void
  onBack: () => void
}

const STEP_LABELS: Array<{ id: SetupStep; label: string }> = [
  { id: 1, label: 'Add Axiom' },
  { id: 2, label: 'Restart' },
  { id: 3, label: 'Map project' },
  { id: 4, label: 'Review' },
]

export function ConnectAgentScreen({ project, fileCount, indexing, onReview, onSkip, onBack }: Props) {
  const [activeStep, setActiveStep] = useState<SetupStep>(1)
  const [copied, setCopied] = useState(false)
  const [hosts, setHosts] = useState<AgentHostInfo[]>([])
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, AgentInstallResult>>({})
  const [installing, setInstalling] = useState<string | null>(null)
  const [hasLivePresence, setHasLivePresence] = useState(false)
  const [liveHostIds, setLiveHostIds] = useState<Set<string>>(() => new Set())
  const [previousHostIds, setPreviousHostIds] = useState<Set<string>>(() => new Set())
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

  // Presence remains live even after a proposal arrives. The mascot and host
  // signal represent who is listening now, not a stale historical phase.
  useEffect(() => {
    const poll = async () => {
      const workspace = encodeURIComponent(project.id)
      if (phase !== 'proposed') {
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
          if (body.connected) setPhase('connected')
        }
      } catch { /* durable action history remains the fallback */ }

      try {
        const res = await fetch(`http://127.0.0.1:7743/api/agent/actions?workspace=${workspace}&limit=200`)
        if (!res.ok) return
        const body = await res.json() as unknown
        const list = (Array.isArray(body) ? body : (body as { actions?: unknown[] })?.actions ?? []) as Array<{ agent?: string }>
        setPreviousHostIds(new Set(
          list.map(item => item.agent).filter((id): id is string => Boolean(id && id !== 'unknown')),
        ))
        if (list.length > 0) setPhase('connected')
      } catch { /* the next poll retries */ }
    }

    void poll()
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [project.id, phase, setPhase])

  const selectedHost = useMemo(
    () => hosts.find(host => host.id === selectedHostId) ?? null,
    [hosts, selectedHostId],
  )
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
    if (step === 2) return phase !== 'waiting'
    if (step === 3) return phase === 'proposed'
    return false
  }

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

        <nav className="axiom-connect__step-nav" aria-label="Agent setup steps" role="tablist">
          {STEP_LABELS.map(step => (
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
                <p className="axiom-connect__step-kicker">Step 1 of 4</p>
                <h2>Add Axiom to your agent</h2>
                <p className="axiom-connect__step-copy">
                  Choose the agent you use. Axiom adds its MCP connection and the correct reusable mapping workflow.
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
                />
              </div>
            )}

            {activeStep === 2 && (
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

            {activeStep === 3 && (
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

            {activeStep === 4 && (
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

          <AgentMascot
            awake={hasLivePresence}
            proposed={phase === 'proposed'}
            hostLabel={selectedHost?.label ?? 'agent'}
            connectedBefore={previousHostIds.size > 0}
          />
        </div>

        <footer className="axiom-connect__footer">
          <span>Steps are always available—you can move back and forth at any time.</span>
          <button type="button" onClick={onSkip}>Open canvas without mapping</button>
        </footer>
      </main>
    </div>
  )
}

function StepActions({
  backLabel,
  onBack,
  nextLabel,
  onNext,
}: {
  backLabel?: string
  onBack?: () => void
  nextLabel?: string
  onNext?: () => void
}) {
  if (!onBack && !onNext) return null
  return (
    <div className="axiom-connect__step-actions">
      {onBack && <button type="button" className="axiom-connect__secondary" onClick={onBack}>{backLabel}</button>}
      {onNext && <button type="button" className="axiom-connect__primary" onClick={onNext}>{nextLabel} →</button>}
    </div>
  )
}

function AgentMascot({
  awake,
  proposed,
  hostLabel,
  connectedBefore,
}: {
  awake: boolean
  proposed: boolean
  hostLabel: string
  connectedBefore: boolean
}) {
  const state = awake ? 'awake' : proposed ? 'proposed' : 'sleeping'
  const caption = awake
    ? `${hostLabel} is listening`
    : proposed
      ? 'The map is ready'
      : connectedBefore
        ? 'Waiting for a fresh session'
        : 'Your mapping agent is asleep'

  return (
    <aside className="axiom-connect__mascot" data-state={state} aria-live="polite">
      <svg viewBox="0 0 320 320" role="img" aria-labelledby="axiom-agent-title axiom-agent-description">
        <title id="axiom-agent-title">Axiom mapping agent</title>
        <desc id="axiom-agent-description">{awake ? 'An alert rubber-hose drafting scout connected to Axiom.' : 'A rubber-hose drafting scout sleeping until a connection arrives.'}</desc>
        <defs>
          <pattern id="axiom-agent-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(18)">
            <path d="M0 0V7" className="agent-hatch-line" />
          </pattern>
          <linearGradient id="axiom-agent-brass" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#e1bd63" />
            <stop offset="1" stopColor="#9b6e22" />
          </linearGradient>
        </defs>
        <ellipse className="agent-shadow" cx="160" cy="292" rx="94" ry="15" />
        <g className="agent-rays">
          <path d="M70 85 43 67M250 85l27-18M160 42V11M94 49 82 20M226 49l12-29" />
        </g>
        <g className="agent-zs">
          <text x="238" y="93">Z</text>
          <text x="262" y="65">Z</text>
          <text x="281" y="34">Z</text>
        </g>

        <g className="agent-character">
          <path className="agent-antenna" d="M160 66c-1-9 7-12 1-21" />
          <path className="agent-antenna-spring" d="M151 50h19M152 44h17" />
          <circle className="agent-beacon-ring" cx="160" cy="33" r="13" />
          <circle className="agent-beacon" cx="160" cy="33" r="7" />

          <g className="agent-blueprint">
            <path d="M81 177h32v74H81z" />
            <path d="M87 188h19M87 197h13M87 213l8-7 9 10M87 232h18" />
            <path d="M77 177c0-6 9-6 9 0v74c0 6-9 6-9 0Z" />
          </g>

          <path className="agent-leg agent-leg--left" d="M133 247c-2 17-12 24-10 38" />
          <path className="agent-leg agent-leg--right" d="M188 247c3 17 11 24 9 38" />
          <path className="agent-sock" d="M119 270h14M190 270h14" />
          <path className="agent-shoe agent-shoe--left" d="M123 281c-19-3-35 4-39 14 15 3 31 2 47-1Z" />
          <path className="agent-shoe agent-shoe--right" d="M197 281c19-3 35 4 39 14-15 3-31 2-47-1Z" />
          <path className="agent-shoe-shine" d="M94 291q12-6 24-4M226 291q-12-6-24-4" />

          <g className="agent-arms agent-arms--sleeping">
            <path className="agent-arm" d="M111 176c-28 0-37 21-24 39 8 11 20 10 29 1" />
            <path className="agent-arm" d="M209 176c28 0 37 21 24 39-8 11-20 10-29 1" />
            <path className="agent-glove" d="M117 207c-10-3-19 2-19 12 5-4 9-4 13-1-1 4 1 8 6 10 7-3 10-12 6-18Z" />
            <path className="agent-glove" d="M203 207c10-3 19 2 19 12-5-4-9-4-13-1 1 4-1 8-6 10-7-3-10-12-6-18Z" />
          </g>

          <g className="agent-arms agent-arms--awake">
            <path className="agent-arm" d="M111 174c-24-2-39 18-27 37 7 11 18 13 28 6" />
            <path className="agent-glove" d="M112 207c-10-2-18 4-17 14 5-5 10-5 14-2 0 5 4 8 9 8 7-5 8-14 2-20Z" />
            <path className="agent-arm agent-wave-arm" d="M209 174c23-5 28-24 17-40-7-10-5-20 2-29" />
            <g className="agent-wave-hand">
              <path className="agent-glove" d="M226 110c-5-7-3-19 4-24 0 7 2 11 5 13 2-7 6-12 11-13-3 7-3 12-1 15 5-5 10-7 14-5-6 7-10 13-10 19-7 6-17 4-23-5Z" />
              <path className="agent-glove-detail" d="M235 99l3 9M245 101l-2 9" />
            </g>
          </g>

          <path className="agent-body-shadow" d="M114 163c5-20 21-31 46-31s41 11 46 31l9 72c2 15-10 27-25 27h-60c-15 0-27-12-25-27Z" />
          <path className="agent-body" d="M108 157c5-20 22-31 52-31s47 11 52 31l8 76c2 15-10 27-25 27h-70c-15 0-27-12-25-27Z" />
          <path className="agent-body-hatch" d="M108 157c5-20 22-31 52-31s47 11 52 31l8 76c2 15-10 27-25 27h-70c-15 0-27-12-25-27Z" />
          <path className="agent-collar" d="M126 137l34 29-23 17-18-35M194 137l-34 29 23 17 18-35" />
          <path className="agent-tie" d="M151 171l9-7 9 7-9 10Z" />
          <circle className="agent-coat-button" cx="160" cy="198" r="4" />
          <circle className="agent-coat-button" cx="160" cy="218" r="4" />
          <path className="agent-pocket" d="M177 204h26v22h-26" />
          <g className="agent-badge">
            <path d="M118 195h27v31h-27z" />
            <path d="m124 218 8-16 8 16M127 212h10" />
          </g>

          <path className="agent-neck" d="M139 137v-13h42v13" />
          <path className="agent-ear agent-ear--left" d="M90 94h17v42H90c-7-11-7-31 0-42Z" />
          <path className="agent-ear agent-ear--right" d="M213 94h17c7 11 7 31 0 42h-17Z" />
          <circle className="agent-ear-rivet" cx="96" cy="115" r="4" />
          <circle className="agent-ear-rivet" cx="224" cy="115" r="4" />
          <path className="agent-head-shadow" d="M106 68c12-13 96-13 108 0 9 10 12 68 0 82-13 15-95 15-108 0-12-14-9-72 0-82Z" />
          <path className="agent-head" d="M100 62c12-13 108-13 120 0 9 10 12 70 0 84-13 15-107 15-120 0-12-14-9-74 0-84Z" />
          <path className="agent-head-highlight" d="M111 69c12-8 86-9 100 0" />
          <path className="agent-faceplate" d="M112 79c12-9 84-9 96 0 7 8 8 49 0 57-12 10-84 10-96 0-8-8-7-49 0-57Z" />

          <g className="agent-face agent-face--sleeping">
            <path d="M124 104q13 10 26 0M170 104q13 10 26 0" />
            <path d="M147 130q13-7 26 0" />
          </g>
          <g className="agent-face agent-face--awake">
            <ellipse cx="137" cy="105" rx="10" ry="14" />
            <ellipse cx="183" cy="105" rx="10" ry="14" />
            <circle cx="140" cy="102" r="3.5" />
            <circle cx="186" cy="102" r="3.5" />
            <path d="M144 129q16 15 32 0" />
          </g>
          <path className="agent-brow agent-brow--left" d="M122 84q15-8 29 0" />
          <path className="agent-brow agent-brow--right" d="M169 84q15-8 29 0" />
          <circle className="agent-cheek" cx="121" cy="124" r="3" />
          <circle className="agent-cheek" cx="199" cy="124" r="3" />
        </g>
      </svg>
      <div className="axiom-connect__mascot-copy">
        <span className="axiom-connect__mascot-light" aria-hidden="true" />
        <strong>{caption}</strong>
        <small>{awake ? 'Connection detected live' : proposed ? 'Ready for your approval' : 'It wakes when an agent reaches Axiom'}</small>
      </div>
    </aside>
  )
}
