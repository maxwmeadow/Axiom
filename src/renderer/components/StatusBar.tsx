import { useGraphStore } from '../store/graphStore'
import { useShallow } from 'zustand/react/shallow'

export function StatusBar() {
  const { systems, files, dependencies, isIndexing, indexingProgress, connectionStatus } = useGraphStore(
    useShallow(s => ({
      systems: s.systems,
      files: s.files,
      dependencies: s.dependencies,
      isIndexing: s.isIndexing,
      indexingProgress: s.indexingProgress,
      connectionStatus: s.connectionStatus,
    }))
  )

  return (
    <div className="axiom-status-bar">
      {/* Connection status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: connectionStatus === 'connected' ? 'var(--ok)' : connectionStatus === 'connecting' ? 'var(--warn)' : 'var(--error)',
        }} />
        <span>{connectionStatus === 'connected' ? 'archd connected' : connectionStatus === 'connecting' ? 'connecting…' : 'disconnected'}</span>
      </div>

      {/* Indexing progress */}
      {isIndexing && indexingProgress && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent)' }}>
          <div style={{ width: 80, height: 3, background: 'var(--bg-raised)', borderRadius: 0 }}>
            <div style={{
              height: '100%', borderRadius: 0,
              background: 'var(--accent)',
              width: `${Math.round((indexingProgress.indexed / indexingProgress.total) * 100)}%`,
              transition: 'width 0.1s',
            }} />
          </div>
          <span>Indexing {indexingProgress.indexed}/{indexingProgress.total}</span>
        </div>
      )}

      {/* Graph stats */}
      {!isIndexing && files.length > 0 && (
        <div style={{ display: 'flex', gap: 12 }}>
          <span>{systems.length} systems</span>
          <span>{files.length} files</span>
          <span>{dependencies.length} dependencies</span>
        </div>
      )}
    </div>
  )
}
