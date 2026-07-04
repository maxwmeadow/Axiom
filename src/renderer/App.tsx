import React, { useEffect, useState, useCallback } from 'react'
import { ReactFlowProvider } from '@xyflow/react'

import { AxiomCanvas } from './canvas/AxiomCanvas'
import { Toolbar } from './components/Toolbar'
import { StatusBar } from './components/StatusBar'
import { DetailPanel } from './components/DetailPanel'
import { SearchBar } from './components/SearchBar'
import { AgentActivityLog } from './components/AgentActivityLog'
import { AgentConnectBanner } from './components/AgentConnectBanner'
import { InjectConfirmBanner } from './components/InjectConfirmBanner'
import { ReplayBar } from './components/ReplayBar'
import { HomeScreen } from './screens/HomeScreen'
import { ProjectSetupScreen } from './screens/ProjectSetupScreen'
import { ProjectReviewScreen } from './screens/ProjectReviewScreen'

import { useGraphStore, connectToArchd } from './store/graphStore'
import type { ProjectConfig } from '../shared/types'
import { useShallow } from 'zustand/react/shallow'

import { demoSnapshot } from './demo/demoGraph'
import { ErrorBoundary } from './components/ErrorBoundary'

export default function App() {
  const [searchOpen, setSearchOpen] = useState(false)
  const [currentProject, setCurrentProject] = useState<ProjectConfig | null>(null)
  // Pending project awaiting setup configuration before indexing starts
  const [pendingSetup, setPendingSetup] = useState<ProjectConfig | null>(null)
  const [reviewActive, setReviewActive] = useState(false)

  const { applySnapshot, setConnectionStatus, setCurrentProject: setStoreProject } = useGraphStore(
    useShallow(s => ({
      applySnapshot: s.applySnapshot,
      setConnectionStatus: s.setConnectionStatus,
      setCurrentProject: s.setCurrentProject,
    }))
  )

  // In browser mode, connect to archd WebSocket on mount
  useEffect(() => {
    if (!window.axiom) {
      connectToArchd()
    }
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (currentProject) setSearchOpen(s => !s)
      }
      if (e.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [currentProject])

  const openProject = useCallback(async (config: ProjectConfig) => {
    setCurrentProject(config)
    setStoreProject(config)

    const isCompleted = localStorage.getItem(`review_completed_${config.id}`) === 'true'
    setReviewActive(!isCompleted)

    if (window.axiom) {
      // Save to recent projects list via IPC
      await window.axiom.openProject(config)
      // Connect to archd WebSocket for real-time graph updates
      connectToArchd('ws://127.0.0.1:7744/ws')
      // Register workspace with archd and start indexing
      console.log('[openProject] posting workspace:', { workspaceId: config.id, rootPath: config.rootPath, ignoredPaths: config.ignoredPaths })
      fetch('http://127.0.0.1:7743/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: config.id,
          name: config.name,
          rootPath: config.rootPath,
          ignoredPaths: config.ignoredPaths,
        }),
      }).catch(err => console.error('[openProject] archd workspace error:', err))
    } else {
      // Browser demo: load fake data
      setConnectionStatus('connected')
      setTimeout(() => {
        applySnapshot(demoSnapshot)
      }, 800)
    }
  }, [applySnapshot, setConnectionStatus])

  const openProjectDialog = useCallback(async () => {
    if (window.axiom) {
      const config = await window.axiom.openProjectDialog()
      if (config) {
        // Show setup screen so user can configure ignored paths before indexing.
        // Pass the full config so the ID computed by main.ts is preserved.
        setPendingSetup(config)
      }
    }
  }, [])

  const confirmSetup = useCallback((config: ProjectConfig) => {
    setPendingSetup(null)
    openProject(config)
  }, [openProject])

  const cancelSetup = useCallback(() => {
    setPendingSetup(null)
  }, [])

  // Project setup configuration screen (after folder picked, before indexing)
  if (pendingSetup) {
    return (
      <ProjectSetupScreen
        baseConfig={pendingSetup}
        onConfirm={confirmSetup}
        onCancel={cancelSetup}
      />
    )
  }

  // Home screen when no project is open
  if (!currentProject) {
    return (
      <HomeScreen
        onOpenProject={(config) => {
          // Recent projects with no ignored paths configured yet go through setup
          if (config.ignoredPaths.length === 0) {
            setPendingSetup(config)
          } else {
            openProject(config)
          }
        }}
        onOpenDialog={openProjectDialog}
      />
    )
  }

  // Review screen for project indexing review phase
  if (currentProject && reviewActive) {
    return (
      <ProjectReviewScreen
        project={currentProject}
        onFinishReview={() => {
          localStorage.setItem(`review_completed_${currentProject.id}`, 'true')
          setReviewActive(false)
        }}
        onBack={() => {
          setCurrentProject(null)
          setStoreProject(null)
          setReviewActive(false)
        }}
      />
    )
  }

  return (
    <ReactFlowProvider>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
        {/* Top toolbar */}
        <Toolbar
          onSearch={() => setSearchOpen(true)}
          onOpenProject={openProjectDialog}
          projectName={currentProject.name}
        />

        {/* Canvas area */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <ErrorBoundary>
            <AxiomCanvas />
          </ErrorBoundary>

          {/* Detail panel (right side) */}
          <DetailPanel />

          {/* Search overlay */}
          {searchOpen && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 999 }}
                onClick={() => setSearchOpen(false)}
              />
              <SearchBar onClose={() => setSearchOpen(false)} />
            </>
          )}

          {/* Agent activity log (bottom-left) */}
          <AgentActivityLog />

          {/* Agent connect banner — shown after raw indexing completes */}
          <AgentConnectBanner />

          {/* Perturbation warn-and-confirm gate */}
          <InjectConfirmBanner />

          {/* Investigation Capture replay controls */}
          <ReplayBar />
        </div>

        {/* Status bar */}
        <StatusBar />
      </div>
    </ReactFlowProvider>
  )
}
