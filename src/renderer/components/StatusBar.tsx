import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'
import { useOnboardingStore } from '../store/onboardingStore'

const CONNECTION_LABELS = {
  connected: 'connected',
  connecting: 'connecting…',
  disconnected: 'disconnected',
} as const

export function StatusBar() {
  const {
    systems,
    files,
    dependencies,
    isIndexing,
    indexingProgress,
    connectionStatus,
    delta,
    deltaReviewing,
    deltaDeferredUntil,
    startDeltaReview,
  } = useGraphStore(
    useShallow(state => ({
      systems: state.systems,
      files: state.files,
      dependencies: state.dependencies,
      isIndexing: state.isIndexing,
      indexingProgress: state.indexingProgress,
      connectionStatus: state.connectionStatus,
      delta: state.delta,
      deltaReviewing: state.deltaReviewing,
      deltaDeferredUntil: state.deltaDeferredUntil,
      startDeltaReview: state.startDeltaReview,
    }))
  )
  const indexingTotal = indexingProgress?.total ?? 0
  const indexingValue = Math.min(indexingProgress?.indexed ?? 0, indexingTotal)

  // "Later" hides the invitation, not the work. Without a way back the delta
  // would be unreachable until the next window, so the status bar keeps it.
  // No count here: the panel ranks and folds claims before showing a number, and
  // a status bar that disagrees with the panel it opens is worse than silent.
  const setAside = Boolean(delta) && !deltaReviewing && deltaDeferredUntil === delta?.until

  const { guideDismissed, guideComplete, revealGuide } = useOnboardingStore(
    useShallow(state => ({
      guideDismissed: Boolean(state.progress.dismissed),
      guideComplete: Boolean(state.progress.completed),
      revealGuide: state.reveal,
    }))
  )
  // Same contract as the delta: hiding something must never strand it.
  const guideRecoverable = guideDismissed && !guideComplete

  return (
    <footer className="axiom-status-bar" aria-label="Application status">
      <div
        className="axiom-status-bar__segment axiom-status-bar__connection"
        data-connection-state={connectionStatus}
        aria-live="polite"
      >
        <span className="axiom-status-bar__lamp" aria-hidden="true" />
        <span>archd {CONNECTION_LABELS[connectionStatus]}</span>
      </div>

      <div className="axiom-status-bar__metrics" aria-label="Graph statistics">
        <span className="axiom-status-bar__metric">
          <strong>{systems.length}</strong>
          <span>systems</span>
        </span>
        <span className="axiom-status-bar__metric">
          <strong>{files.length}</strong>
          <span>files</span>
        </span>
        <span className="axiom-status-bar__metric">
          <strong>{dependencies.length}</strong>
          <span>dependencies</span>
        </span>
      </div>

      {setAside && (
        <button
          type="button"
          className="axiom-status-bar__segment axiom-status-bar__delta"
          onClick={startDeltaReview}
          title="You set this delta aside. Nothing has been acknowledged yet."
        >
          <span className="axiom-status-bar__lamp" aria-hidden="true" />
          <span>Delta set aside - review</span>
        </button>
      )}

      {guideRecoverable && (
        <button
          type="button"
          className="axiom-status-bar__segment axiom-status-bar__guide"
          onClick={revealGuide}
          title="Reopen the setup guide"
        >
          <span>Setup guide</span>
        </button>
      )}

      {isIndexing && indexingProgress ? (
        <div className="axiom-status-bar__segment axiom-status-bar__indexing" aria-live="polite">
          <span>Indexing</span>
          <progress
            aria-label="Indexing progress"
            value={indexingValue}
            max={Math.max(indexingTotal, 1)}
          />
          <strong>{indexingProgress.indexed}/{indexingProgress.total}</strong>
        </div>
      ) : null}
    </footer>
  )
}
