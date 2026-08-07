import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { onboardingStage, type OnboardingStage } from '../../shared/onboarding'
import { findSheetByName, untakenSheetName } from '../../shared/sheetNames'
import { useGraphStore } from '../store/graphStore'
import { useOnboardingStore } from '../store/onboardingStore'
import { useSheetStore } from '../store/sheetStore'

const FIRST_INCREMENT = 'First Increment'

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

export function OnboardingGuide({ projectId }: { projectId: string }) {
  const { loadedProjectId, progress, patch, dismiss, complete } = useOnboardingStore(useShallow(state => ({
    loadedProjectId: state.projectId,
    progress: state.progress,
    patch: state.patch,
    dismiss: state.dismiss,
    complete: state.complete,
  })))
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

  // Progress belongs to a project. Until the store is pointed at this one, the
  // guide neither reads nor writes it — a switch would otherwise record this
  // project's sheets against the previous project's progress.
  const ready = loadedProjectId === projectId

  // The guide follows a real sheet, not a local flag. Three things it must
  // survive, all of which used to restart the walkthrough and mint a duplicate:
  //  · a relaunch, where sheets are listed but no layer is loaded yet;
  //  · the user building their first increment from the rail instead of here;
  //  · that sheet later being deleted.
  const sheet = useMemo(() => {
    const remembered = progress.sheetId
      ? sheets.find(item => item.id === progress.sheetId)
      : undefined
    if (remembered) return remembered
    if (progress.sheetId) return undefined  // deleted — fall back to step one
    return findSheetByName(sheets, FIRST_INCREMENT) ?? sheets[0]
  }, [sheets, progress.sheetId])

  // Adopt whatever sheet we ended up following, so the next launch reads it
  // straight out of local progress instead of guessing again.
  useEffect(() => {
    if (!ready) return
    if (sheet && progress.sheetId !== sheet.id) {
      patch({ sheetId: sheet.id })
    } else if (!sheet && progress.sheetId) {
      patch({ sheetId: undefined, plannedId: undefined })
    }
  }, [ready, sheet, progress.sheetId, patch])

  // Only an opened sheet has its layer in memory; until then we cannot know
  // whether it holds planned work, and the guide asks the user to open it.
  const layer = sheet ? layersById[sheet.id] : undefined
  const guidePlans = layer?.planned ?? []
  const plan = progress.plannedId
    ? guidePlans.find(item => item.id === progress.plannedId)
    : guidePlans[0]

  useEffect(() => {
    if (ready && !progress.plannedId && plan) {
      patch({ plannedId: plan.id })
    }
  }, [ready, plan, progress.plannedId, patch])

  const dispatchedMessage = useMemo(
    () => messages.find(message => message.sheetId === sheet?.id),
    [messages, sheet?.id],
  )
  useEffect(() => {
    if (ready && !progress.dispatched && dispatchedMessage) {
      patch({ dispatched: true })
    }
  }, [ready, dispatchedMessage, progress.dispatched, patch])

  const stage = onboardingStage({
    baselineReady: files.length > 0 && !isIndexing,
    // Existence, not loadedness. The sheet is a durable row in archd; whether
    // its layer happens to be in memory is a detail of what is open right now.
    sheetReady: Boolean(sheet),
    planned: Boolean(plan),
    dispatched: Boolean(progress.dispatched),
    realized: plan?.status === 'realized' || plan?.status === 'flattened',
  })
  const copy = COPY[stage]

  // Say nothing until this project's own progress is loaded. Rendering against
  // the default would flash step one at someone who finished months ago.
  if (!ready) return null

  // Hiding sticks across launches — "not now" that reappears every morning is
  // just nagging. The status bar keeps the way back while the loop is open.
  if (progress.dismissed) return null

  const createFirstIncrement = async () => {
    setBusy(true)
    setError(null)
    try {
      // If a First Increment is already sitting there, this is a re-entry, not
      // a new build — adopt it rather than minting a same-named twin.
      const existing = findSheetByName(sheets, FIRST_INCREMENT)
      const target = existing ?? await createSheet(
        projectId,
        untakenSheetName(sheets, FIRST_INCREMENT),
        'The first draw → dispatch → realized cycle',
        [],
      )
      await openSheet(projectId, target.id)
      patch({ sheetId: target.id })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the first increment.')
    } finally {
      setBusy(false)
    }
  }

  const activateGuideSheet = async () => {
    if (!sheet) return
    setBusy(true)
    await openSheet(projectId, sheet.id)
    setBusy(false)
  }

  const finish = () => complete()

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
        onClick={dismiss}
        aria-label="Hide the setup guide"
        title="Hide — reopen from the status bar"
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
        {stage === 'draw' && activeSheetId !== sheet?.id && (
          <button onClick={() => void activateGuideSheet()} disabled={busy}>
            {busy ? 'Opening…' : `Open ${sheet?.name ?? 'First Increment'}`}
          </button>
        )}
        {stage === 'draw' && activeSheetId === sheet?.id && (
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
