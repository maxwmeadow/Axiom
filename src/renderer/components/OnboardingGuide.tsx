import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { onboardingStage, type OnboardingStage } from '../../shared/onboarding'
import { useGraphStore } from '../store/graphStore'
import { useSheetStore } from '../store/sheetStore'

interface GuideProgress {
  startedAt: number
  sheetId?: string
  plannedId?: string
  dispatched?: boolean
}

const COPY: Record<OnboardingStage, {
  eyebrow: string
  title: string
  body: string
}> = {
  baseline: {
    eyebrow: 'REVERSE SYNC',
    title: 'Your codebase is materializing',
    body: 'Axiom is turning the repository into live files, systems, and relationships. The first index is a baseline, not a fake change.',
  },
  sheet: {
    eyebrow: 'FORWARD SYNC · 1 OF 3',
    title: 'Create your first increment',
    body: 'A Sheet is an intent layer over the live Floor. Start one small build without changing the code yet.',
  },
  draw: {
    eyebrow: 'FORWARD SYNC · 2 OF 3',
    title: 'Draw what should exist',
    body: 'Drag one File, Class, Service, or System stencil onto the canvas and give it a real name.',
  },
  dispatch: {
    eyebrow: 'FORWARD SYNC · 3 OF 3',
    title: 'Dispatch the approved spec',
    body: 'Send the active Sheet to your agent. The queued work order keeps an immutable snapshot of what you approved.',
  },
  build: {
    eyebrow: 'LIVE REALIZATION',
    title: 'Now watch the plan go green',
    body: 'Your agent can drain the canvas queue through Axiom MCP. As matching code appears, the planned node moves through partial to realized.',
  },
  complete: {
    eyebrow: 'LOOP CLOSED',
    title: 'You built in both directions',
    body: 'Code became a map; intent became code. This project is ready to use as a daily command deck.',
  },
}

function readProgress(projectId: string): GuideProgress {
  try {
    const raw = localStorage.getItem(`onboarding_progress_${projectId}`)
    if (raw) return JSON.parse(raw) as GuideProgress
  } catch {
    // A damaged local hint must never block the workbench.
  }
  return { startedAt: Date.now() }
}

export function OnboardingGuide({ projectId }: { projectId: string }) {
  const [progress, setProgress] = useState<GuideProgress>(() => readProgress(projectId))
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { files, isIndexing } = useGraphStore(useShallow(state => ({
    files: state.files,
    isIndexing: state.isIndexing,
  })))
  const {
    sheets, activeSheetId, layersById, messages,
    createSheet, openSheet,
  } = useSheetStore(useShallow(state => ({
    sheets: state.sheets,
    activeSheetId: state.activeSheetId,
    layersById: state.layersById,
    messages: state.messages,
    createSheet: state.createSheet,
    openSheet: state.openSheet,
  })))

  useEffect(() => {
    localStorage.setItem(`onboarding_progress_${projectId}`, JSON.stringify(progress))
  }, [progress, projectId])

  const sheet = progress.sheetId
    ? sheets.find(item => item.id === progress.sheetId)
    : undefined
  const guidePlans = progress.sheetId
    ? (layersById[progress.sheetId]?.planned ?? [])
    : []
  const plan = progress.plannedId
    ? guidePlans.find(item => item.id === progress.plannedId)
    : guidePlans[0]

  useEffect(() => {
    if (!progress.plannedId && plan) {
      setProgress(current => ({ ...current, plannedId: plan.id }))
    }
  }, [plan, progress.plannedId])

  const dispatchedMessage = useMemo(
    () => messages.find(message =>
      message.sheetId === progress.sheetId &&
      message.createdAt >= progress.startedAt
    ),
    [messages, progress.sheetId, progress.startedAt],
  )
  useEffect(() => {
    if (!progress.dispatched && dispatchedMessage) {
      setProgress(current => ({ ...current, dispatched: true }))
    }
  }, [dispatchedMessage, progress.dispatched])

  const stage = onboardingStage({
    baselineReady: files.length > 0 && !isIndexing,
    sheetReady: Boolean(sheet && layersById[sheet.id]),
    planned: Boolean(plan),
    dispatched: Boolean(progress.dispatched),
    realized: plan?.status === 'realized' || plan?.status === 'flattened',
  })
  const copy = COPY[stage]

  if (
    hidden ||
    localStorage.getItem(`onboarding_completed_${projectId}`) === 'true'
  ) return null

  const createFirstIncrement = async () => {
    setBusy(true)
    setError(null)
    const created = await createSheet(
      projectId,
      'First Increment',
      'The first draw → dispatch → realized cycle',
      [],
    )
    if (!created) {
      setError('Could not create the first increment.')
      setBusy(false)
      return
    }
    await openSheet(projectId, created.id)
    setProgress(current => ({ ...current, sheetId: created.id }))
    setBusy(false)
  }

  const activateGuideSheet = async () => {
    if (!progress.sheetId) return
    setBusy(true)
    await openSheet(projectId, progress.sheetId)
    setBusy(false)
  }

  const finish = () => {
    localStorage.setItem(`onboarding_completed_${projectId}`, 'true')
    setHidden(true)
  }

  return (
    <aside className={`axiom-onboarding-guide axiom-onboarding-guide--${stage}`} aria-live="polite">
      <div className="axiom-onboarding-guide__rail" aria-hidden="true">
        {['sheet', 'draw', 'dispatch', 'build'].map((item, index) => (
          <span
            key={item}
            className={
              ['sheet', 'draw', 'dispatch', 'build', 'complete'].indexOf(stage) > index
                ? 'is-complete'
                : stage === item ? 'is-active' : ''
            }
          />
        ))}
      </div>
      <button
        className="axiom-onboarding-guide__close"
        onClick={() => setHidden(true)}
        aria-label="Hide onboarding guide for now"
        title="Hide for now"
      >
        ×
      </button>
      <span className="axiom-onboarding-guide__eyebrow">{copy.eyebrow}</span>
      <h2>{copy.title}</h2>
      <p>{copy.body}</p>

      {error && <div className="axiom-onboarding-guide__error" role="alert">{error}</div>}

      <div className="axiom-onboarding-guide__actions">
        {stage === 'baseline' && <span className="axiom-onboarding-guide__waiting">INDEXING LIVE SOURCE…</span>}
        {stage === 'sheet' && (
          <button onClick={() => void createFirstIncrement()} disabled={busy}>
            {busy ? 'Creating…' : 'Create First Increment'}
          </button>
        )}
        {stage === 'draw' && activeSheetId !== progress.sheetId && (
          <button onClick={() => void activateGuideSheet()} disabled={busy}>Open First Increment</button>
        )}
        {stage === 'draw' && activeSheetId === progress.sheetId && (
          <span className="axiom-onboarding-guide__waiting">DRAG A STENCIL FROM THE LEFT</span>
        )}
        {stage === 'dispatch' && (
          <button onClick={() => window.dispatchEvent(new Event('axiom:open-agent-dispatch'))}>
            Dispatch Increment
          </button>
        )}
        {stage === 'build' && (
          <span className="axiom-onboarding-guide__waiting">
            {plan?.status === 'partial' ? 'PARTIAL · KEEP BUILDING' : 'AWAITING AGENT BUILD'}
          </span>
        )}
        {stage === 'complete' && <button onClick={finish}>Enter Command Deck</button>}
      </div>
    </aside>
  )
}
