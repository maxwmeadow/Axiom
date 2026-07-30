import { useEffect, useRef, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { AxiomCanvas } from '../canvas/AxiomCanvas'
import { useGraphStore } from '../store/graphStore'
import type { ProjectConfig } from '../../shared/types'
import { WorkbenchTitleBar } from '../components/ui/WorkbenchTitleBar'

interface ProjectReviewScreenProps {
  project: ProjectConfig
  onFinishReview: () => void
  onBack: () => void
}

type CopyFeedback = {
  field: 'command' | 'path'
  state: 'copied' | 'failed'
} | null

export function ProjectReviewScreen({ project, onFinishReview, onBack }: ProjectReviewScreenProps) {
  const [mcpPath, setMcpPath] = useState('')
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const terminalEndRef = useRef<HTMLDivElement>(null)

  const { agentActivities, clearAgentActivities, files } = useGraphStore(
    useShallow(state => ({
      agentActivities: state.agentActivities,
      clearAgentActivities: state.clearAgentActivities,
      files: state.files,
    }))
  )

  useEffect(() => {
    let active = true
    if (window.axiom) {
      void window.axiom.getAppInfo()
        .then(info => {
          if (active) setMcpPath(info.mcpPath || '')
        })
        .catch(() => {
          if (active) setMcpPath('')
        })
    }
    return () => {
      active = false
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [agentActivities])

  const totalFiles = files.length
  const unclassifiedCount = files.filter(file => !file.systemId).length
  const classifiedCount = totalFiles - unclassifiedCount
  const classificationPercent = totalFiles === 0 ? 100 : Math.round((classifiedCount / totalFiles) * 100)
  const universalCommand = `npx tsx "${mcpPath || 'axiom-mcp.ts'}"`
  const hasReviewEvents = agentActivities.length > 0

  const handleCopy = async (text: string, field: 'command' | 'path') => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopyFeedback({ field, state: 'copied' })
    } catch {
      setCopyFeedback({ field, state: 'failed' })
    }

    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopyFeedback(null), 2_000)
  }

  return (
    <main className="axiom-onboarding axiom-project-review">
      <WorkbenchTitleBar
        context={`${project.name} / Baseline Review`}
        status={hasReviewEvents ? 'EVENTS RECEIVED' : 'AWAITING REVIEW'}
        statusTone={hasReviewEvents ? 'ready' : 'busy'}
      />

      <div className="axiom-review__workspace">
        <section className="axiom-review__panel" aria-labelledby="review-title">
          <header className="axiom-review__heading">
            <button className="axiom-onboarding__back" onClick={onBack} aria-label="Back to project navigator">
              <span aria-hidden="true">←</span>
              Project Navigator
            </button>
            <div className="axiom-onboarding__step">STEP 02 / LIVE BASELINE</div>
            <h1 id="review-title">Your codebase is becoming a map</h1>
            <p>
              This is your real repository materializing on the Floor, not a sample project or setup preview.
              Verify the boundaries while files and relationships settle into place.
            </p>
          </header>

          <dl className="axiom-review__metrics" aria-label="Baseline classification summary">
            <ReviewMetric label="Source files" value={String(totalFiles)} />
            <ReviewMetric label="Classified" value={String(classifiedCount)} />
            <ReviewMetric
              label="Needs review"
              value={String(unclassifiedCount)}
              tone={unclassifiedCount > 0 ? 'attention' : 'complete'}
            />
          </dl>

          <div className="axiom-review__progress" aria-label={`${classificationPercent}% of files classified`}>
            <div>
              <span>CLASSIFICATION COVERAGE</span>
              <strong>{classificationPercent}%</strong>
            </div>
            <progress max={100} value={classificationPercent}>{classificationPercent}%</progress>
          </div>

          <div className="axiom-review__scroll">
            <section className="axiom-review__connection" aria-labelledby="agent-connection-title">
              <div className="axiom-review__section-heading">
                <span>OPTIONAL ASSISTANCE</span>
                <div>
                  <h2 id="agent-connection-title">Agent review connection</h2>
                  <p>Point an MCP-capable editor at Axiom, then ask it to “start a review.”</p>
                </div>
              </div>

              <ConnectionField
                label="MCP COMMAND"
                value={universalCommand}
                feedback={copyFeedback?.field === 'command' ? copyFeedback.state : null}
                onCopy={() => void handleCopy(universalCommand, 'command')}
              />
              <ConnectionField
                label="APPLICATION SCRIPT"
                value={mcpPath}
                placeholder="Locating application script…"
                feedback={copyFeedback?.field === 'path' ? copyFeedback.state : null}
                onCopy={() => void handleCopy(mcpPath, 'path')}
              />
            </section>

            <section className="axiom-review-log" aria-labelledby="review-log-title">
              <header>
                <div>
                  <span>LIVE EVENT STREAM</span>
                  <h2 id="review-log-title">Review activity</h2>
                </div>
                {agentActivities.length > 0 && (
                  <button onClick={clearAgentActivities}>Clear log</button>
                )}
              </header>

              <div className="axiom-review-log__terminal" role="log" aria-live="polite">
                {agentActivities.length === 0 ? (
                  <div className="axiom-review-log__empty">
                    <span aria-hidden="true" />
                    <p>No review commands have been received. The canvas remains fully editable while you inspect it.</p>
                  </div>
                ) : (
                  agentActivities.map((activity, index) => (
                    <div
                      className={`axiom-review-log__entry axiom-review-log__entry--${activity.level}`}
                      key={`${activity.timestamp}-${index}`}
                    >
                      <time>{formatTime(activity.timestamp)}</time>
                      <span aria-hidden="true" />
                      <p>{activity.message}</p>
                    </div>
                  ))
                )}
                <div ref={terminalEndRef} />
              </div>
            </section>
          </div>

          <footer className="axiom-review__actions">
            <p>Next, Axiom will guide one small draw → dispatch → green cycle on top of this live Floor.</p>
            <button className="axiom-onboarding__primary" onClick={onFinishReview}>
              <span>
                <strong>Finish Review</strong>
                <small>Enter the architecture workbench</small>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          </footer>
        </section>

        <section className="axiom-review__canvas" aria-label="Interactive architecture review canvas">
          <ReactFlowProvider>
            <AxiomCanvas readOnly={false} />
          </ReactFlowProvider>

          <div className="axiom-review__canvas-note">
            <span className="axiom-review__canvas-signal" aria-hidden="true" />
            <div>
              <strong>INTERACTIVE REVIEW FLOOR</strong>
              <p>Move, resize, and regroup the indexed architecture directly while reviewing the baseline.</p>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}

function ReviewMetric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'attention' | 'complete'
}) {
  return (
    <div className={`axiom-review__metric axiom-review__metric--${tone}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function ConnectionField({
  label,
  value,
  placeholder,
  feedback,
  onCopy,
}: {
  label: string
  value: string
  placeholder?: string
  feedback: 'copied' | 'failed' | null
  onCopy: () => void
}) {
  const buttonLabel = feedback === 'copied' ? 'Copied' : feedback === 'failed' ? 'Copy failed' : 'Copy'

  return (
    <div className="axiom-review__connection-field">
      <label>{label}</label>
      <div>
        <code className={value ? '' : 'axiom-review__connection-placeholder'}>{value || placeholder}</code>
        <button onClick={onCopy} disabled={!value} aria-label={`Copy ${label.toLowerCase()}`}>
          {buttonLabel}
        </button>
      </div>
    </div>
  )
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}
