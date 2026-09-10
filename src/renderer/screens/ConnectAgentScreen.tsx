import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectConfig } from '../../shared/types'
import type { AgentHostInfo, AgentInstallResult } from '../../../electron/preload'
import { AgentMascot } from '../components/AgentMascot'
import { WorkbenchTitleBar } from '../components/ui/WorkbenchTitleBar'
import { commandKind, presentAgentHost, presentAgentFamily } from './connectAgentPresentation'

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

interface AgentFamilyGroup {
  id: string
  label: string
  modalities: AgentHostInfo[]
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
  // Families with more than one modality collapse by default: the row states
  // what it is, and the surfaces underneath are opened deliberately.
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(() => new Set())
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
    setHosts(found)
    setSelectedHostId(current => {
      if (current && found.some(host => host.id === current)) return current
      return found.find(host => host.configured && host.workflowInstalled)?.id
        ?? found.find(host => host.detected)?.id
        ?? found[0]?.id
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

  // Group hosts by family
  const families: AgentFamilyGroup[] = useMemo(() => {
    const map = new Map<string, AgentFamilyGroup>()
    for (const host of hosts) {
      const fid = host.familyId || host.id
      const flabel = host.familyLabel || host.label
      const existing = map.get(fid)
      if (existing) {
        existing.modalities.push(host)
      } else {
        map.set(fid, { id: fid, label: flabel, modalities: [host] })
      }
    }
    return [...map.values()]
  }, [hosts])

  // A live presence response is the gate.
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
    () => hosts.find(host => host.id === selectedHostId) ?? hosts[0] ?? null,
    [hosts, selectedHostId],
  )

  const selectedFamily = useMemo(() => {
    if (!selectedHost) return families[0] ?? null
    return families.find(f => f.id === selectedHost.familyId) ?? null
  }, [families, selectedHost])

  const mascotState = !blankProject && phase === 'proposed'
    ? 'proposal-ready'
    : hasLivePresence
      ? 'connected'
      : 'sleeping'

  const selectedPresentation = selectedHost
    ? presentAgentHost(selectedHost, results[selectedHost.id], liveHostIds.has(selectedHost.id))
    : null

  const selectedReady = selectedPresentation?.state === 'installed' || selectedPresentation?.state === 'live'

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

  const installFamily = async (family: AgentFamilyGroup) => {
    setInstalling(family.id)
    try {
      const outcome = await window.axiom.installFamily(family.id, project.rootPath)
      setResults(current => {
        const next = { ...current }
        for (const m of family.modalities) {
          next[m.id] = outcome
        }
        return next
      })
      if (outcome.ok) showHosts(await window.axiom.listAgentHosts(project.rootPath))
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Could not install family.'
      setResults(current => {
        const next = { ...current }
        for (const m of family.modalities) {
          next[m.id] = { ok: false, detail, paths: [] }
        }
        return next
      })
    } finally {
      setInstalling(null)
    }
  }

  const copyText = async (text?: string | null) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2200)
    } catch {
      setCopied(false)
    }
  }

  const stepComplete = (step: SetupStep) => {
    if (step === 1) {
      return hosts.some(host => {
        const state = presentAgentHost(host, results[host.id], liveHostIds.has(host.id)).state
        return state === 'installed' || state === 'live'
      })
    }
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
                    ? 'Choose the agent and harness you use. Axiom adds its MCP connection and reusable workflows.'
                    : 'Choose the agent and harness you use. Axiom adds its MCP connection and reusable mapping workflows.'}
                </p>

                <ul className="axiom-connect__families" aria-label="Supported agents and modalities">
                  {families.map(family => {
                    const familyPres = presentAgentFamily(
                      family.id,
                      family.label,
                      family.modalities,
                      results,
                      liveHostIds,
                    )
                    const isFamilyActive = selectedFamily?.id === family.id
                    const activeModalityInFamily = isFamilyActive
                      ? selectedHost
                      : family.modalities[0]

                    const modPresentation = activeModalityInFamily
                      ? presentAgentHost(
                          activeModalityInFamily,
                          results[activeModalityInFamily.id],
                          liveHostIds.has(activeModalityInFamily.id),
                        )
                      : null

                    const activeResult = activeModalityInFamily ? results[activeModalityInFamily.id] : undefined

                    return (
                      <li
                        key={family.id}
                        className="axiom-connect__family-card"
                        data-selected={isFamilyActive}
                        data-state={familyPres.state}
                      >
                        <div className="axiom-connect__family-header">
                          <label className="axiom-connect__agent-choice">
                            <input
                              type="radio"
                              name="axiom-agent-family"
                              value={family.id}
                              checked={isFamilyActive}
                              onChange={() => {
                                const target = family.modalities.find(m => m.detected) ?? family.modalities[0]
                                chooseHost(target.id)
                              }}
                            />
                            {/* Parent Intelligent Light Signal */}
                            <span
                              className="axiom-connect__host-signal"
                              data-state={familyPres.state}
                              data-tooltip={familyPres.detail}
                              tabIndex={0}
                              aria-label={`${family.label} status: ${familyPres.detail}`}
                            />
                            <strong>{family.label}</strong>
                          </label>

                          {family.modalities.length > 1 && (
                            <button
                              type="button"
                              className="axiom-connect__family-disclosure"
                              aria-expanded={expandedFamilies.has(family.id)}
                              aria-controls={`modalities-${family.id}`}
                              onClick={() => setExpandedFamilies(previous => {
                                const next = new Set(previous)
                                if (next.has(family.id)) next.delete(family.id)
                                else next.add(family.id)
                                return next
                              })}
                            >
                              <span className="axiom-connect__family-disclosure-count">
                                {familyPres.installedCount > 0
                                  ? `${familyPres.installedCount}/${family.modalities.length} configured`
                                  : `${family.modalities.length} surfaces`}
                              </span>
                              <span className="axiom-connect__family-chevron" aria-hidden="true" />
                            </button>
                          )}

                          <div className="axiom-connect__family-actions">
                            {familyPres.canBatchInstall && familyPres.batchAction !== 'none' && (
                              <button
                                type="button"
                                className="axiom-connect__install axiom-connect__install--batch"
                                disabled={installing === family.id}
                                onClick={() => void installFamily(family)}
                              >
                                {installing === family.id
                                  ? 'Working…'
                                  : familyPres.batchAction === 'install'
                                    ? 'Install all detected'
                                    : 'Reinstall all'}
                              </button>
                            )}

                            {/* A collapsed family hides which modality is
                                selected, so acting on one from here would be a
                                guess. Only the batch action makes sense until
                                the surfaces are visible. */}
                            {modPresentation && modPresentation.action !== 'none'
                              && (family.modalities.length === 1 || expandedFamilies.has(family.id)) && (
                              <button
                                type="button"
                                className="axiom-connect__install"
                                disabled={installing === activeModalityInFamily?.id}
                                onClick={() => {
                                  if (activeModalityInFamily) void installHost(activeModalityInFamily)
                                }}
                              >
                                {installing === activeModalityInFamily?.id
                                  ? 'Working…'
                                  : modPresentation.action === 'install'
                                    ? `Install`
                                    : modPresentation.action === 'repair'
                                      ? 'Repair'
                                      : 'Reinstall'}
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Modality Tabs */}
                        {family.modalities.length > 1 && expandedFamilies.has(family.id) && (
                          <div
                            id={`modalities-${family.id}`}
                            className="axiom-connect__modality-tabs"
                            role="tablist"
                            aria-label={`${family.label} modalities`}
                          >
                            {family.modalities.map(modality => {
                              const isSelected = selectedHostId === modality.id
                              const mPres = presentAgentHost(
                                modality,
                                results[modality.id],
                                liveHostIds.has(modality.id),
                              )
                              return (
                                <button
                                  key={modality.id}
                                  type="button"
                                  role="tab"
                                  aria-selected={isSelected}
                                  className="axiom-connect__modality-tab"
                                  data-selected={isSelected}
                                  data-state={mPres.state}
                                  onClick={() => chooseHost(modality.id)}
                                >
                                  {/* Modality child status dot */}
                                  <span
                                    className="axiom-connect__modality-dot"
                                    data-state={mPres.state}
                                    title={mPres.detail}
                                  />
                                  <span>{modality.modalityLabel || modality.label}</span>
                                </button>
                              )
                            })}
                          </div>
                        )}

                        {activeResult && isFamilyActive && (
                          <p className="axiom-connect__install-result" data-ok={activeResult.ok}>
                            {activeResult.detail}
                          </p>
                        )}
                      </li>
                    )
                  })}
                </ul>

                <StepActions
                  nextLabel={selectedReady ? `Continue with ${selectedHost?.modalityLabel || selectedHost?.label}` : 'Continue'}
                  onNext={() => setActiveStep(2)}
                  nextDisabled={!selectedReady}
                />
              </div>
            )}

            {activeStep === 2 && blankProject && (
              <div className="axiom-connect__step-panel">
                <p className="axiom-connect__step-kicker">Step 2 of 2</p>
                <h2>Connect {selectedHost?.modalityLabel || selectedHost?.label || 'your agent'}</h2>
                {hasLivePresence ? (
                  <>
                    <p className="axiom-connect__step-copy">
                      {selectedHost?.modalityLabel || selectedHost?.label} is connected and Axiom is ready.
                    </p>
                    <div className="axiom-connect__waiting-line" data-state="connected" aria-live="polite">
                      <span aria-hidden="true" /> Live connection confirmed
                    </div>
                  </>
                ) : selectedReady ? (
                  <>
                    <p className="axiom-connect__step-copy">
                      {selectedHost?.restartDetail || 'Restart it and open a new session. Agents load MCP connections at startup.'}
                    </p>
                    <div className="axiom-connect__instruction-card">
                      <span aria-hidden="true">↻</span>
                      <p><strong>{selectedHost?.restartAction || 'Start fresh.'}</strong> Keep Axiom open while the agent connects.</p>
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
                <h2>{selectedHost?.restartAction || `Restart ${selectedHost?.modalityLabel || selectedHost?.label}`}</h2>

                {/* Modality switcher if multiple are in this family */}
                {selectedFamily && selectedFamily.modalities.length > 1 && (
                  <div className="axiom-connect__step-tabs" role="tablist">
                    {selectedFamily.modalities.map(m => (
                      <button
                        key={m.id}
                        type="button"
                        className="axiom-connect__step-tab"
                        data-selected={selectedHostId === m.id}
                        onClick={() => chooseHost(m.id)}
                      >
                        {m.modalityLabel || m.label}
                      </button>
                    ))}
                  </div>
                )}

                {selectedReady ? (
                  <>
                    <p className="axiom-connect__step-copy">
                      {selectedHost?.restartDetail || 'Close its existing session and open a new one. Agents load MCP connections and workflows at startup.'}
                    </p>
                    <div className="axiom-connect__instruction-card">
                      <span aria-hidden="true">↻</span>
                      <p><strong>{selectedHost?.restartAction || 'Restart'}:</strong> {selectedHost?.restartDetail}</p>
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
                <h2>Ask {selectedHost?.modalityLabel || selectedHost?.label} to map this project</h2>

                {/* Modality switcher if multiple are in this family */}
                {selectedFamily && selectedFamily.modalities.length > 1 && (
                  <div className="axiom-connect__step-tabs" role="tablist">
                    {selectedFamily.modalities.map(m => (
                      <button
                        key={m.id}
                        type="button"
                        className="axiom-connect__step-tab"
                        data-selected={selectedHostId === m.id}
                        onClick={() => chooseHost(m.id)}
                      >
                        {m.modalityLabel || m.label}
                      </button>
                    ))}
                  </div>
                )}

                {selectedHost?.triggerKind === 'chat prompt' ? (
                  <>
                    <p className="axiom-connect__step-copy">
                      In {selectedHost.modalityLabel || selectedHost.label}, paste this instruction into the chat:
                    </p>
                    <div className="axiom-connect__command" data-kind="chat prompt">
                      <span>{selectedHost.promptText || selectedHost.command}</span>
                      <button type="button" onClick={() => void copyText(selectedHost.promptText || selectedHost.command)}>
                        {copied ? 'Copied ✓' : 'Copy prompt'}
                      </button>
                    </div>
                    <p className="axiom-connect__command-note">
                      This prompts {selectedHost.modalityLabel || selectedHost.label} to use Axiom&apos;s tools to map the codebase.
                    </p>
                  </>
                ) : selectedHost?.command ? (
                  <>
                    <p className="axiom-connect__step-copy">
                      {selectedReady ? 'In the new session, run' : 'Once Axiom is installed, run'} this {commandKind(selectedHost.command, selectedHost.triggerKind)} exactly as shown.
                    </p>
                    <div className="axiom-connect__command" data-kind={commandKind(selectedHost.command, selectedHost.triggerKind)}>
                      <span>{selectedHost.command}</span>
                      <button type="button" onClick={() => void copyText(selectedHost.command)}>{copied ? 'Copied ✓' : 'Copy'}</button>
                    </div>
                    <p className="axiom-connect__command-note">
                      The workflow carries Axiom’s mapping brief. You do not need to paste any extra prompt.
                    </p>
                  </>
                ) : (
                  <p className="axiom-connect__step-copy">
                    {selectedHost?.modalityLabel || selectedHost?.label} is not ready yet. Return to step 1 and install or repair Axiom first.
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
                      ? `${selectedHost?.modalityLabel || selectedHost?.label} is connected and working. Axiom will light this step when the proposal arrives.`
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
            <AgentMascot state={mascotState} hostLabel={selectedHost?.modalityLabel || selectedHost?.label || 'agent'} />
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
