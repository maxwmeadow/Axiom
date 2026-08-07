import React, { useEffect, useState, useCallback } from 'react'
import { ReactFlowProvider } from '@xyflow/react'

import { AxiomCanvas } from './canvas/AxiomCanvas'
import { subscribeToDeltaRefresh } from './canvas/deltaRefresh'
import { Toolbar } from './components/Toolbar'
import { StatusBar } from './components/StatusBar'
import { DetailPanel } from './components/DetailPanel'
import { SearchBar } from './components/SearchBar'
import { AgentConnectBanner } from './components/AgentConnectBanner'
import { InjectConfirmBanner } from './components/InjectConfirmBanner'
import { AgentLogPanel } from './components/AgentLogPanel'
import { PaperTextureDefs } from './canvas/nodes/PaperTexture'
import { DeltaPanel } from './components/DeltaPanel'
import { ReplayBar } from './components/ReplayBar'
import { OnboardingGuide } from './components/OnboardingGuide'
import { AgentLane } from './components/AgentLane'
import { InterruptionLane } from './components/InterruptionLane'
import { HomeScreen } from './screens/HomeScreen'
import { ProjectSetupScreen } from './screens/ProjectSetupScreen'
import { ProjectReviewScreen } from './screens/ProjectReviewScreen'

import { useGraphStore, connectToArchd } from './store/graphStore'
import { useOnboardingStore } from './store/onboardingStore'
import { raiseFailure, useInterruptionStore } from './store/interruptionStore'
import { useRegistryStore } from './store/registryStore'
import { SheetRail } from './components/SheetRail'
import type { ProjectConfig } from '../shared/types'
import {
  completeSourceBoundaries,
  resolveProjectSourceBoundaries,
  sourceBoundariesAreComplete,
} from '../shared/projectLifecycle'
import { useShallow } from 'zustand/react/shallow'

import { demoSnapshot } from './demo/demoGraph'
import { ErrorBoundary } from './components/ErrorBoundary'

const APP_PARAMS = new URLSearchParams(window.location.search)
const E2E_MODE = APP_PARAMS.get('e2e') === '1'
const E2E_HOME = E2E_MODE && APP_PARAMS.get('home') === '1'
const E2E_SETUP = E2E_MODE && APP_PARAMS.get('setup') === '1'
const E2E_REVIEW = E2E_MODE && APP_PARAMS.get('review') === '1'
const E2E_PROJECT: ProjectConfig = {
  id: 'demo',
  name: 'Axiom Canvas Fixture',
  rootPath: '/axiom-e2e',
  ignoredPaths: [],
  languageOverrides: {},
  layoutPreferences: { zoom: 1, panX: 0, panY: 0 },
  openedAt: 0,
}

export default function App() {
  const [searchOpen, setSearchOpen] = useState(false)
  const [agentLogOpen, setAgentLogOpen] = useState(false)
  const [currentProject, setCurrentProject] = useState<ProjectConfig | null>(
    E2E_MODE && !E2E_HOME && !E2E_SETUP ? E2E_PROJECT : null
  )
  // Pending project awaiting setup configuration before indexing starts
  const [pendingSetup, setPendingSetup] = useState<ProjectConfig | null>(
    E2E_SETUP ? { ...E2E_PROJECT, rootPath: '.' } : null
  )
  const [reviewActive, setReviewActive] = useState(E2E_REVIEW)
  const enterOnboardingProject = useOnboardingStore(s => s.enterProject)

  const { applySnapshot, setConnectionStatus, setCurrentProject: setStoreProject } = useGraphStore(
    useShallow(s => ({
      applySnapshot: s.applySnapshot,
      setConnectionStatus: s.setConnectionStatus,
      setCurrentProject: s.setCurrentProject,
    }))
  )

  // In browser mode, connect to archd WebSocket on mount
  useEffect(() => {
    if (E2E_MODE) {
      if (E2E_HOME || E2E_SETUP) {
        setStoreProject(null)
        setConnectionStatus('connected')
        return
      }
      setStoreProject(E2E_PROJECT)
      setConnectionStatus('connected')
      applySnapshot(demoSnapshot)
      // E2E-only affordance: expose the store so tests can drive live patches
      // (graph:patch choreography) deterministically without a real daemon.
      ;(window as unknown as { __axiomGraphStore?: unknown }).__axiomGraphStore = useGraphStore
      return
    }
    if (!window.axiom) {
      connectToArchd()
    }
    // Infra service registry — one fetch, shared by canvas nodes and dialogs
    void useRegistryStore.getState().fetchRegistry()
  }, [applySnapshot, setConnectionStatus, setStoreProject])

  // A delta:ready event covers project open. Focus refresh covers the other
  // daily path: Axiom stayed open while an agent changed the architecture.
  useEffect(() => {
    if (E2E_MODE) return
    return subscribeToDeltaRefresh(window, () => useGraphStore.getState().loadDelta())
  }, [])

  // Load this project's onboarding progress before anything renders against it,
  // so the guide and the status bar agree about where the user left off.
  useEffect(() => {
    if (currentProject) enterOnboardingProject(currentProject.id)
  }, [currentProject, enterOnboardingProject])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
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
    // Questions and failures belong to the project that raised them. A new
    // workspace starts with an empty lane.
    useInterruptionStore.getState().clear()

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
          sourceBoundariesReviewedAt: config.sourceBoundariesReviewedAt,
        }),
      }).then(() => {
        // Snapshot is pushed over WS on open, but if the socket connects a
        // beat late the broadcast is missed and the canvas stays empty — pull
        // it explicitly, retrying while indexing warms up.
        let tries = 0
        const pull = async () => {
          tries++
          // A WebSocket patch may beat this cold-load fallback. Once live data
          // exists, never replace it with a snapshot that would clear node FX.
          const live = useGraphStore.getState()
          if (live.systems.length > 0 || live.files.length > 0 || live.infraNodes.length > 0) {
            return
          }
          try {
            const res = await fetch(`http://127.0.0.1:7743/api/snapshot/${config.id}`)
            if (res.ok) {
              const snap = await res.json()
              const hasGraph = (snap.systems?.length ?? 0) > 0 ||
                (snap.files?.length ?? 0) > 0 ||
                (snap.infraNodes?.length ?? 0) > 0
              if (hasGraph || tries >= 10) {
                const latest = useGraphStore.getState()
                if (latest.systems.length > 0 || latest.files.length > 0 || latest.infraNodes.length > 0) {
                  return
                }
                applySnapshot(snap)
                return
              }
            }
          } catch { /* archd still starting */ }
          if (tries < 10) {
            setTimeout(pull, 1500)
            return
          }
          // Giving up silently left the user staring at a blank canvas with
          // nothing to read and nothing to click. Say what happened, and make
          // retrying one button rather than a restart.
          raiseFailure(
            'snapshot-cold-load',
            'Could not load this project from archd',
            'The daemon did not answer after 15 seconds. Your code is untouched — this is the map, not the repository.',
            [{
              label: 'Retry',
              primary: true,
              run: () => {
                useInterruptionStore.getState().resolve('snapshot-cold-load')
                tries = 0
                void pull()
              },
            }],
          )
        }
        void pull()
      }).catch(err => console.error('[openProject] archd workspace error:', err))
    } else {
      // Browser demo: load fake data
      setConnectionStatus('connected')
      setTimeout(() => {
        applySnapshot(demoSnapshot)
      }, 800)
    }
  }, [applySnapshot, setConnectionStatus])

  const routeProjectBySourceBoundaryState = useCallback(async (config: ProjectConfig) => {
    if (sourceBoundariesAreComplete(config)) {
      await openProject(config)
      return
    }

    // Migrate projects indexed before explicit completion state existed. The
    // backend is authoritative because projects.json/localStorage can be
    // cleared independently from the per-project index.
    const scopeUrl =
      `http://127.0.0.1:7743/api/workspace-scope/${encodeURIComponent(config.id)}?rootPath=${encodeURIComponent(config.rootPath)}`
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(scopeUrl)
      if (response.ok) {
        const status = await response.json() as {
          indexed: boolean
          ignoredPaths?: string[]
          sourceBoundariesReviewedAt?: number | null
        }
        const completed = resolveProjectSourceBoundaries(config, status)
        if (completed) {
          await openProject(completed)
          return
        }
      }
      } catch {
        // archd may still be starting directly after the Electron window.
      }
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    setPendingSetup(config)
  }, [openProject])

  const openProjectDialog = useCallback(async () => {
    if (window.axiom) {
      const config = await window.axiom.openProjectDialog()
      if (config) {
        await routeProjectBySourceBoundaryState(config)
      }
    }
  }, [routeProjectBySourceBoundaryState])

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
          void routeProjectBySourceBoundaryState(config)
        }}
        onOpenDialog={openProjectDialog}
        onCreateProject={(config) => {
          // A brand-new empty project has nothing to scope or review — land
          // directly on the live Floor so files materialize as they're built.
          const completed = completeSourceBoundaries(config, [])
          localStorage.setItem(`review_completed_${completed.id}`, 'true')
          openProject(completed)
        }}
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
          agentLogOpen={agentLogOpen}
          onToggleAgentLog={() => setAgentLogOpen(open => !open)}
        />

        {/* Sheet rail + canvas area */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <SheetRail />
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {/* REVISION 2: sheets are layers over the live canvas, not separate
              views — AxiomCanvas renders the base layer + active sheet overlay. */}
          <ErrorBoundary>
            <AxiomCanvas />
          </ErrorBoundary>

          {/* Paint servers every node references. Defined once; renders nothing. */}
          <PaperTextureDefs />

          {/* Morning Delta — what changed while you weren't watching */}
          <DeltaPanel />

          {/* Detail panel (right side) */}
          <DetailPanel />

          {/* Search overlay */}
          {searchOpen && <SearchBar onClose={() => setSearchOpen(false)} />}

          {/* The one surface anything is allowed to interrupt you through.
              Everything below raises into it and renders nothing itself. */}
          <InterruptionLane />

          {/* Raises an invitation when indexed files have no system */}
          <AgentConnectBanner />

          {/* Raises a decision when an agent asks to override a runtime value */}
          <InjectConfirmBanner />

          {/* Agent activity log — everything the agent is doing, live */}
          {agentLogOpen && <AgentLogPanel onClose={() => setAgentLogOpen(false)} />}

          {/* Investigation Capture replay controls */}
          <ReplayBar />

          {!E2E_MODE && <OnboardingGuide projectId={currentProject.id} />}

          {/* Which worktree each agent is in, and how the branches relate.
              Mount point owned by the parallel-agents track; renders nothing
              until that track fills it in. Do not move or remove. */}
          <AgentLane />
          </div>
        </div>

        {/* Status bar */}
        <StatusBar />
      </div>
    </ReactFlowProvider>
  )
}
