import { useShallow } from 'zustand/react/shallow'
import { useGraphStore } from '../store/graphStore'

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
  } = useGraphStore(
    useShallow(state => ({
      systems: state.systems,
      files: state.files,
      dependencies: state.dependencies,
      isIndexing: state.isIndexing,
      indexingProgress: state.indexingProgress,
      connectionStatus: state.connectionStatus,
    }))
  )
  const indexingTotal = indexingProgress?.total ?? 0
  const indexingValue = Math.min(indexingProgress?.indexed ?? 0, indexingTotal)

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
