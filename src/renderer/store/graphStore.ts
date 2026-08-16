import { create } from 'zustand'
import { shouldAnimateIndividualClassification } from '../canvas/canvasPerformance.ts'
import type {
  AgentAction,
  ProjectConfig,
  DbSystem,
  DbFile,
  DbInfraNode,
  DbDependency,
  CanvasSnapshot,
  FloorLayout,
  DbGraphPatch,
  DeltaSummary,
  FileDeletePatch,
  FileUpdatePatch,
  LivingRelationshipChange,
  DeltaWorkSession,
} from '../../shared/types'
import { apiAckDelta, apiGetAgentActions, apiGetDelta } from '../canvas/arcdApi.ts'
import {
  agentAttentionFor,
  expireAttention,
  mergeAttention,
  type AgentAttention,
} from '../canvas/agentActionVisual.ts'

// How long a read keeps a node lit. Long enough to notice an agent sweeping
// through a region, short enough that the map is not permanently glowing.
const AGENT_ATTENTION_MS = 2600
// Recent actions kept in memory for the visual log; archd holds the full log.
const AGENT_LOG_WINDOW = 300

import { handleSheetPatch } from './sheetStore.ts'
import type { NodeFx } from '../canvas/sceneTypes'
import {
  editNodeFxKind,
  livingFlowEndpoints,
  relationshipVisual,
} from '../canvas/livingChoreography.ts'
import {
  activeLivingFlowDiagnostics,
  recordLivingFlowDiagnostic,
} from '../canvas/livingDiagnostics.ts'

export interface CallTraceStep {
  callerFile: string
  callerSymbol: string
  calleeFile: string
  calleeSymbol: string
  callCount: number
}

export type LivingRelationshipFx = LivingRelationshipChange & {
  key: number
  startedAt: number
  delayMs: number
  travelMs: number
  eventCount: number
}

// ─── Runtime layer types (mirror archd-go/internal/runtime) ─────────────────

export interface RuntimeValue {
  type: string
  value: string
}

export interface RuntimeWatch {
  id: string
  workspaceId: string
  fileId: string
  relPath: string
  symbol: string
  lineStart: number
  lineEnd: number
  callCount: number
  lastArgs?: Record<string, RuntimeValue>
  lastReturn?: RuntimeValue
  lastError?: string
  lastCallAt?: number
  rateLimited: boolean
}

export interface RuntimeEvent {
  kind: 'call' | 'return' | 'exception' | 'rate_limit'
  watchId: string
  traceId?: string
  parentTraceId?: string
  /** Present when this event happened inside a perturbed call subtree. */
  injectId?: string
  ts: number
  args?: Record<string, RuntimeValue>
  returnValue?: RuntimeValue
  durationMs?: number
  excType?: string
  message?: string
  fileId: string
  relPath: string
  symbol: string
  callCount: number
}

export interface RuntimeSession {
  id: string
  workspaceId: string
  language: string
  pid: number
  runtimeVersion: string
  connectedAt: number
}

/** One captured event in an investigation timeline (matches the Go CapturedEvent). */
export interface CapturedEvent {
  type: string
  offsetMs: number
  payload: unknown
}

/** A saved investigation document (matches the Go Investigation). */
export interface InvestigationDoc {
  id: string
  name: string
  commit: string
  branch: string
  createdAt: number
  durationMs: number
  events: CapturedEvent[]
  canvasSnapshot?: unknown
}

export interface ReplayState {
  id: string
  name: string
  commit: string
  branch: string
  events: CapturedEvent[]
  cursor: number   // index of the last-applied event; -1 = nothing applied yet
  playing: boolean
}

export interface RuntimeInjection {
  id: string
  workspaceId: string
  fileId: string
  relPath: string
  symbol: string
  paramName: string
  value: unknown
  once: boolean
  status: 'pending_confirm' | 'armed' | 'fired' | 'denied' | 'expired' | 'removed' | 'error'
  error?: string
  createdAt: number
  firedAt?: number
  originalValue?: RuntimeValue
  injectedValue?: RuntimeValue
}

/** Per-file aggregation of runtime activity, consumed by FileNode. */
export interface RuntimeNodeState {
  watchedSymbols: string[]
  callCount: number
  /** Incremented on every call - remounts the pulse ring to replay the animation. */
  pulseKey: number
  lastKind: RuntimeEvent['kind'] | null
  /** Compact human-readable summary of the last event, e.g. `validate(amount=-1.0)` */
  lastLabel: string
  rateLimited: boolean
  /** Perturbation: orange while an injection is pending/armed on this file. */
  injection: 'pending_confirm' | 'armed' | null
  /** Outcome of the last perturbed call touching this file: green or red. */
  verdict: 'pass' | 'fail' | null
  // Structured last-seen values for the hover tooltip.
  lastSymbol: string
  lastArgs: string
  lastReturn: string
  lastException: string
}

// ─── Store shape ──────────────────────────────────────────────────────────────

interface GraphState {
  // Project
  currentProject: ProjectConfig | null
  recentProjects: ProjectConfig[]

  // Graph data (matches Go CanvasSnapshot)
  systems: DbSystem[]
  files: DbFile[]
  infraNodes: DbInfraNode[]
  dependencies: DbDependency[]
  floorLayouts: FloorLayout[]

  // Canvas expand/collapse state
  expandedSystemIds: Set<string>

  // UI state
  selectedNodeId: string | null
  inspectedNodeId: string | null
  infraPickerNodeId: string | null
  indexingProgress: { indexed: number; total: number } | null
  isIndexing: boolean
  connectionStatus: 'disconnected' | 'connecting' | 'connected'
  selectionMode: boolean
  agentActivities: { message: string; level: 'info' | 'warn' | 'success' | 'error'; timestamp: number }[]
  addAgentActivity: (activity: { message: string; level: 'info' | 'warn' | 'success' | 'error' }) => void
  clearAgentActivities: () => void

  // Call trace - set when an agent queries a call path; cleared after timeout or new trace
  activeTrace: CallTraceStep[] | null
  setActiveTrace: (trace: CallTraceStep[] | null) => void

  // Data-flow slice - set of file IDs in the current variable-reference slice
  dataFlow: { variable: string; fileIds: Set<string> } | null
  setDataFlow: (flow: { variable: string; fileIds: string[] } | null) => void

  // Live choreography - transient per-node animation intents (enter/edit) set
  // by applyDbPatch as the map changes, stamped onto nodes and auto-expired so
  // the canvas visibly reacts to real code edits. Not persisted.
  nodeFx: Record<string, NodeFx>
  clearNodeFx: (id: string, key: number) => void
  relationshipFx: LivingRelationshipFx[]
  clearRelationshipFx: (key: number) => void
  pendingFileDeletions: Record<string, number>
  finalizeFileDeletion: (id: string, key: number) => void

  // Morning Delta - the net architectural diff accumulated while Axiom was
  // closed or unattended. Loaded on project open and window focus; never
  // auto-dismissed, because an unreviewed delta is the reason to open Axiom.
  delta: DeltaSummary | null
  activeWorkSessions: DeltaWorkSession[]

  // Agent action log - everything an agent did, including reads. The log is
  // durable in archd; this holds the recent window for the visual log, plus
  // the transient attention signals the canvas renders. Attention is the ONLY
  // visual this stream owns; see agentActionVisual.ts for why.
  agentActions: AgentAction[]
  agentAttention: Record<string, AgentAttention>
  applyAgentAction: (action: AgentAction) => void
  clearAgentAttention: (key: number) => void
  loadAgentActions: () => Promise<void>
  deltaReviewing: boolean
  deltaCursor: number
  // "Later" set aside the delta without acknowledging it. It stays unreviewed
  // in archd; only the invitation is hidden, and the status bar keeps a way
  // back. Deferral is per delta window - a newer one re-invites on its own.
  deltaDeferredUntil: number
  loadDelta: () => Promise<void>
  startDeltaReview: () => void
  setDeltaCursor: (cursor: number) => void
  deferDelta: () => void
  endDeltaReview: (acknowledge: boolean) => void
  applyWorkSession: (session: DeltaWorkSession) => void

  // Runtime layer - live sessions, watches, per-file activity
  runtimeSessions: RuntimeSession[]
  runtimeWatches: Record<string, RuntimeWatch>
  runtimeNodes: Record<string, RuntimeNodeState>
  runtimeInjections: Record<string, RuntimeInjection>
  applyRuntimeSession: (session: RuntimeSession, status: 'connected' | 'disconnected') => void
  applyRuntimeWatch: (watch: RuntimeWatch) => void
  removeRuntimeWatch: (watch: RuntimeWatch) => void
  applyRuntimeEvents: (events: RuntimeEvent[]) => void
  applyRuntimeInject: (inject: RuntimeInjection) => void

  // Investigation replay (Phase 8) - re-feeds captured events through the live
  // render path so a saved investigation plays back on the canvas.
  replay: ReplayState | null
  startReplay: (doc: InvestigationDoc) => void
  stopReplay: () => void
  replaySeek: (index: number) => void      // reset visuals + apply events[0..index]
  replayNext: () => boolean                // apply next event incrementally; false at end
  resetRuntimeVisuals: () => void

  // Actions
  setCurrentProject: (p: ProjectConfig | null) => void
  setRecentProjects: (ps: ProjectConfig[]) => void
  applySnapshot: (snap: CanvasSnapshot) => void
  applyClassification: (snap: CanvasSnapshot) => void
  applyDbPatch: (patch: DbGraphPatch) => void
  toggleSystemExpanded: (id: string) => void
  collapseAll: () => void
  setSelectedNode: (id: string | null) => void
  setInspectedNode: (id: string | null) => void
  setInfraPickerNode: (id: string | null) => void
  setIndexingProgress: (progress: { indexed: number; total: number } | null) => void
  beginIndexing: () => void
  setIndexingComplete: () => void
  setConnectionStatus: (s: 'disconnected' | 'connecting' | 'connected') => void
  setSelectionMode: (active: boolean) => void
  /**
   * The documents browser is reachable from two places - the toolbar and the
   * documents bin on the canvas - so the flag lives here rather than in either
   * of them. Two local flags would let two browsers open at once.
   */
  documentsOpen: boolean
  setDocumentsOpen: (open: boolean) => void
  /**
   * Bumped whenever an unplaced file arrives. A counter rather than a flag so
   * a second arrival during the first animation restarts it instead of being
   * swallowed - the bin should pulse once per file, not once per burst.
   */
  unsortedArrivalKey: number
  getFile: (id: string) => DbFile | undefined
  getSystem: (id: string) => DbSystem | undefined
}

// Identity token rather than the promise itself: the cleanup runs inside the
// promise being created, so it cannot reference that binding before it exists.
let deltaLoadToken = 0
let deltaLoadInFlight: { workspaceId: string; token: number; promise: Promise<void> } | null = null
let deltaAckInFlight: { workspaceId: string; promise: Promise<void> } | null = null
let deltaRefreshPending = false


/**
 * Systems a human or an agent deliberately named. A system whose source is
 * `cluster` or `directory` was inferred, not decided, and is withheld from the
 * canvas until the architecture has been authored - at which point the authored
 * systems are what there is to show anyway.
 */
function keepAuthoredSystems<T extends { source?: string | null }>(systems: T[]): T[] {
  const authored = systems.filter(
    system => system.source === 'user' || system.source === 'agent',
  )
  return authored.length > 0 ? authored : []
}

export const useGraphStore = create<GraphState>((set, get) => ({
  currentProject: null,
  recentProjects: [],
  systems: [],
  files: [],
  infraNodes: [],
  dependencies: [],
  floorLayouts: [],
  expandedSystemIds: new Set(),
  selectedNodeId: null,
  inspectedNodeId: null,
  infraPickerNodeId: null,
  indexingProgress: null,
  isIndexing: false,
  connectionStatus: 'disconnected',
  selectionMode: false,
  agentActivities: [],
  addAgentActivity: (act) => set((state) => ({
    agentActivities: [...state.agentActivities, { ...act, timestamp: Date.now() }].slice(-100),
  })),
  clearAgentActivities: () => set({ agentActivities: [] }),

  activeTrace: null,
  setActiveTrace: (trace) => set({ activeTrace: trace }),

  delta: null,
  activeWorkSessions: [],
  agentActions: [],
  agentAttention: {},
  applyAgentAction: (action) => set(state => {
    const attention = agentAttentionFor(action, action.id)
    if (attention) {
      // Attention is transient: it says "the agent is looking here NOW".
      window.setTimeout(
        () => useGraphStore.getState().clearAgentAttention(action.id),
        AGENT_ATTENTION_MS,
      )
    }
    return {
      agentActions: [action, ...state.agentActions].slice(0, AGENT_LOG_WINDOW),
      agentAttention: mergeAttention(state.agentAttention, attention),
    }
  }),
  clearAgentAttention: (key) => set(state => {
    const remaining = expireAttention(state.agentAttention, key)
    return remaining === state.agentAttention ? {} : { agentAttention: remaining }
  }),
  loadAgentActions: async () => {
    const workspaceId = get().currentProject?.id
    if (!workspaceId) return
    try {
      set({ agentActions: await apiGetAgentActions(workspaceId) })
    } catch (error) {
      // The log is an observability aid, never a blocker.
      console.error('[agent-log] load failed', error)
    }
  },
  deltaReviewing: false,
  deltaCursor: -1,
  deltaDeferredUntil: 0,
  loadDelta: () => {
    const state = get()
    const workspaceId = state.currentProject?.id
    if (!workspaceId) return Promise.resolve()

    // A review is a snapshot: do not move its claims or cursor underneath the
    // reader. Refresh immediately after they leave the review instead.
    if (state.deltaReviewing) {
      deltaRefreshPending = true
      return Promise.resolve()
    }
    if (deltaAckInFlight?.workspaceId === workspaceId) {
      deltaRefreshPending = true
      return deltaAckInFlight.promise
    }
    if (deltaLoadInFlight?.workspaceId === workspaceId) {
      return deltaLoadInFlight.promise
    }

    const token = ++deltaLoadToken
    const promise = (async () => {
      try {
        const summary = await apiGetDelta(workspaceId)
        const latest = get()
        // Project switches and reviews can happen while fetch is in flight.
        if (latest.currentProject?.id !== workspaceId) return
        if (latest.deltaReviewing) {
          deltaRefreshPending = true
          return
        }
        set({
          delta: summary.empty ? null : summary,
          activeWorkSessions: summary.sessions.filter(session => session.endedAt === 0),
          deltaCursor: -1,
        })
      } catch (error) {
        // A delta is a review aid, never a blocker: failing to load one must
        // not stop the project from opening.
        console.error('[delta] load failed', error)
      } finally {
        if (deltaLoadInFlight?.token === token) {
          deltaLoadInFlight = null
        }
      }
    })()
    deltaLoadInFlight = { workspaceId, token, promise }
    return promise
  },
  startDeltaReview: () => set(state => (state.delta ? { deltaReviewing: true, deltaCursor: 0, deltaDeferredUntil: 0 } : {})),
  setDeltaCursor: (cursor) => set({ deltaCursor: cursor }),
  // Set aside without acknowledging. Pinned to this window's `until`, so work
  // that lands afterwards produces a new window that invites again.
  deferDelta: () => set(state => (state.delta
    ? { deltaDeferredUntil: state.delta.until, deltaReviewing: false, deltaCursor: -1 }
    : {})),
  endDeltaReview: (acknowledge) => {
    const { currentProject, delta } = get()
    // Acknowledge the exact window that was shown - not "now" - so anything
    // that landed mid-review still appears in the next delta.
    if (acknowledge && currentProject && delta) {
      set({ delta: null, deltaReviewing: false, deltaCursor: -1 })
      const workspaceId = currentProject.id
      // Always read once more after ack: changes that landed while the review
      // was open belong to the next window and should surface immediately.
      deltaRefreshPending = true
      const promise = apiAckDelta(workspaceId, delta.until)
        .catch(error => {
          // The server retains the unacknowledged window; the refresh below
          // will restore it instead of silently losing the review.
          console.error('[delta] acknowledge failed', error)
        })
        .finally(() => {
          if (deltaAckInFlight?.promise === promise) {
            deltaAckInFlight = null
          }
          if (get().currentProject?.id === workspaceId && deltaRefreshPending) {
            deltaRefreshPending = false
            void get().loadDelta()
          }
        })
      deltaAckInFlight = { workspaceId, promise }
      return
    }
    set({ deltaReviewing: false, deltaCursor: -1 })
    if (deltaRefreshPending) {
      deltaRefreshPending = false
      void get().loadDelta()
    }
  },
  applyWorkSession: (session) => set(state => {
    if (state.currentProject?.id !== session.workspaceId) return state
    const remaining = state.activeWorkSessions.filter(item => item.id !== session.id)
    return {
      activeWorkSessions: session.endedAt === 0
        ? [...remaining, session].sort((a, b) => a.startedAt - b.startedAt)
        : remaining,
    }
  }),

  dataFlow: null,
  setDataFlow: (flow) => set({
    dataFlow: flow ? { variable: flow.variable, fileIds: new Set(flow.fileIds) } : null,
  }),

  replay: null,
  resetRuntimeVisuals: () => set({
    runtimeSessions: [], runtimeWatches: {}, runtimeNodes: {}, runtimeInjections: {},
    activeTrace: null, dataFlow: null,
  }),
  startReplay: (doc) => {
    get().resetRuntimeVisuals()
    set({
      replay: {
        id: doc.id, name: doc.name, commit: doc.commit, branch: doc.branch,
        events: doc.events ?? [], cursor: -1, playing: false,
      },
    })
  },
  stopReplay: () => {
    get().resetRuntimeVisuals()
    set({ replay: null })
  },
  replayNext: () => {
    const rp = get().replay
    if (!rp || rp.cursor >= rp.events.length - 1) return false
    const next = rp.cursor + 1
    const ev = rp.events[next]
    dispatchReplayEvent(ev)
    set({ replay: { ...rp, cursor: next } })
    return true
  },
  replaySeek: (index) => {
    const rp = get().replay
    if (!rp) return
    const target = Math.max(-1, Math.min(index, rp.events.length - 1))
    // Reset visuals and re-apply from the start for a deterministic frame.
    get().resetRuntimeVisuals()
    for (let i = 0; i <= target; i++) dispatchReplayEvent(rp.events[i])
    set({ replay: { ...get().replay!, cursor: target } })
  },

  runtimeSessions: [],
  runtimeWatches: {},
  runtimeNodes: {},
  runtimeInjections: {},
  nodeFx: {},
  relationshipFx: [],
  pendingFileDeletions: {},

  applyRuntimeSession: (session, status) => set((state) => ({
    runtimeSessions: status === 'connected'
      ? [...state.runtimeSessions.filter(s => s.id !== session.id), session]
      : state.runtimeSessions.filter(s => s.id !== session.id),
  })),

  applyRuntimeWatch: (watch) => set((state) => {
    const watches = { ...state.runtimeWatches, [watch.id]: watch }
    return { runtimeWatches: watches, runtimeNodes: rebuildNodeWatches(state.runtimeNodes, watches) }
  }),

  removeRuntimeWatch: (watch) => set((state) => {
    const watches = { ...state.runtimeWatches }
    delete watches[watch.id]
    return { runtimeWatches: watches, runtimeNodes: rebuildNodeWatches(state.runtimeNodes, watches) }
  }),

  applyRuntimeEvents: (events) => set((state) => {
    const watches = { ...state.runtimeWatches }
    const nodes = { ...state.runtimeNodes }
    for (const ev of events) {
      const w = watches[ev.watchId]
      if (w) {
        watches[ev.watchId] = {
          ...w,
          callCount: ev.kind === 'call' ? ev.callCount : w.callCount,
          lastArgs: ev.kind === 'call' && ev.args ? ev.args : w.lastArgs,
          lastReturn: ev.kind === 'return' && ev.returnValue ? ev.returnValue : w.lastReturn,
          lastError: ev.kind === 'exception' ? `${ev.excType}: ${ev.message}` : w.lastError,
          lastCallAt: ev.kind === 'call' ? ev.ts : w.lastCallAt,
          rateLimited: ev.kind === 'rate_limit' ? true : w.rateLimited,
        }
      }
      const prev = nodes[ev.fileId] ?? emptyNodeState()
      // Verdict: an event inside a perturbed subtree colors this node -
      // clean return = green, exception = red.
      let verdict = prev.verdict
      if (ev.injectId) {
        if (ev.kind === 'return') verdict = 'pass'
        else if (ev.kind === 'exception') verdict = 'fail'
      }
      nodes[ev.fileId] = {
        ...prev,
        watchedSymbols: prev.watchedSymbols.length ? prev.watchedSymbols : nodeSymbols(watches, ev.fileId),
        callCount: ev.kind === 'call' ? prev.callCount + 1 : prev.callCount,
        pulseKey: ev.kind === 'call' || ev.kind === 'exception' ? prev.pulseKey + 1 : prev.pulseKey,
        lastKind: ev.kind,
        lastLabel: eventLabel(ev),
        rateLimited: ev.kind === 'rate_limit' ? true : prev.rateLimited,
        verdict,
        lastSymbol: ev.symbol || prev.lastSymbol,
        lastArgs: ev.kind === 'call' ? formatArgs(ev.args) : prev.lastArgs,
        lastReturn: ev.kind === 'return' ? (ev.returnValue?.value ?? '') : prev.lastReturn,
        lastException: ev.kind === 'exception' ? `${ev.excType}: ${ev.message}` : prev.lastException,
      }
    }
    return { runtimeWatches: watches, runtimeNodes: nodes }
  }),

  applyRuntimeInject: (inject) => set((state) => {
    const injections = { ...state.runtimeInjections, [inject.id]: inject }
    const nodes = { ...state.runtimeNodes }
    // Recompute the perturbation marker for the affected file.
    const active = Object.values(injections).filter(i => i.fileId === inject.fileId)
    const pending = active.some(i => i.status === 'pending_confirm')
    const armed = active.some(i => i.status === 'armed')
    const prev = nodes[inject.fileId] ?? emptyNodeState()
    nodes[inject.fileId] = {
      ...prev,
      injection: pending ? 'pending_confirm' : armed ? 'armed' : null,
      // A newly armed injection starts a fresh experiment - clear the verdict.
      verdict: inject.status === 'armed' ? null : prev.verdict,
    }
    return { runtimeInjections: injections, runtimeNodes: nodes }
  }),

  setCurrentProject: (project) => set((state) => {
    const switchedWorkspace = state.currentProject?.id !== project?.id
    if (!switchedWorkspace) {
      return {
        currentProject: project,
        selectedNodeId: null,
        inspectedNodeId: null,
        infraPickerNodeId: null,
      }
    }
    deltaRefreshPending = false
    return {
      currentProject: project,
      systems: [],
      files: [],
      infraNodes: [],
      dependencies: [],
      floorLayouts: [],
      indexingProgress: null,
      isIndexing: false,
      expandedSystemIds: new Set<string>(),
      selectedNodeId: null,
      inspectedNodeId: null,
      infraPickerNodeId: null,
      nodeFx: {},
      relationshipFx: [],
      pendingFileDeletions: {},
      delta: null,
      activeWorkSessions: [],
      deltaReviewing: false,
      deltaCursor: -1,
      deltaDeferredUntil: 0,
    }
  }),
  setRecentProjects: (ps) => set({ recentProjects: ps }),

  applySnapshot: (snap) => set({
    // Inferred groupings never reach the canvas. The indexer clusters files by
    // import topology and names each pile after its most frequent symbol, which
    // produces boxes called Bar, Lane, Phase and Cochange - words that are real
    // and describe nothing. Drawing those as your architecture teaches people to
    // distrust the map before an agent has had a chance to make it true, and the
    // confusion costs more than the empty space it fills.
    //
    // Until someone authors the architecture, the Floor shows the files
    // themselves. Clustering still runs and its output still serves layout and
    // evidence; it simply no longer claims to be the answer.
    systems: keepAuthoredSystems(snap.systems ?? []),
    files: snap.files ?? [],
    infraNodes: snap.infraNodes ?? [],
    dependencies: snap.dependencies ?? [],
    floorLayouts: snap.floorLayouts ?? [],
    // Start with all top-level systems collapsed
    expandedSystemIds: new Set(),
    // A full snapshot is the resting baseline - drop any pending enter/edit
    // intents so a reload doesn't animate the whole map as if freshly built.
    nodeFx: {},
    relationshipFx: [],
    pendingFileDeletions: {},
  }),

  applyClassification: (snap) => set((state) => {
    const previousSystems = new Map(state.systems.map(system => [system.id, system]))
    const previousFiles = new Map(state.files.map(file => [file.id, file]))
    const nextFx = { ...state.nodeFx }
    const pendingDeletionIds = new Set(Object.keys(state.pendingFileDeletions))
    const nextFiles = (snap.files ?? []).filter(file => !pendingDeletionIds.has(file.id))
    const nextDependencies = (snap.dependencies ?? state.dependencies)
      .filter(dependency => !pendingDeletionIds.has(dependency.src) && !pendingDeletionIds.has(dependency.dst))
    const nextFloorLayouts = (snap.floorLayouts ?? state.floorLayouts)
      .filter(layout => !(layout.nodeType === 'file' && pendingDeletionIds.has(layout.nodeId)))
    const classificationMoveCount = nextFiles.reduce((count, file) => {
      const previous = previousFiles.get(file.id)
      return count + (previous && previous.systemId !== file.systemId ? 1 : 0)
    }, 0)
    const animateIndividualFiles = shouldAnimateIndividualClassification(classificationMoveCount)

    for (const system of snap.systems ?? []) {
      if (previousSystems.has(system.id)) continue
      const key = nextFxKey()
      nextFx[system.id] = { kind: 'enter', key }
      scheduleFxExpiry(system.id, key)
    }

    for (const file of nextFiles) {
      const previous = previousFiles.get(file.id)
      if (!previous || previous.systemId === file.systemId) continue
      // A baseline reconciliation can move hundreds of files at once. Their
      // new systems still receive the enter choreography above, but revealing
      // every hidden file for its own settle animation defeats semantic-zoom
      // virtualization during the most expensive frame of project startup.
      if (!animateIndividualFiles) continue
      // Do not cut off the stronger green creation signal when classification
      // lands during the same write burst.
      if (nextFx[file.id]?.kind === 'enter') continue
      const key = nextFxKey()
      nextFx[file.id] = { kind: 'classify', key }
      scheduleFxExpiry(file.id, key)
    }

    const nextSystemIds = new Set((snap.systems ?? []).map(system => system.id))
    return {
      systems: snap.systems ?? [],
      files: nextFiles,
      infraNodes: snap.infraNodes ?? state.infraNodes,
      dependencies: nextDependencies,
      floorLayouts: nextFloorLayouts,
      expandedSystemIds: new Set(
        [...state.expandedSystemIds].filter(id => nextSystemIds.has(id))
      ),
      nodeFx: nextFx,
    }
  }),

  clearNodeFx: (id, key) => set((state) => {
    const current = state.nodeFx[id]
    if (!current || current.key !== key) return state  // superseded by a newer intent
    const { [id]: _dropped, ...rest } = state.nodeFx
    return { nodeFx: rest }
  }),

  clearRelationshipFx: (key) => set((state) => {
    const event = state.relationshipFx.find(candidate => candidate.key === key)
    if (event) {
      const endpoints = livingFlowEndpoints(event)
      recordLivingFlowDiagnostic('renderer-expired', {
        traceId: event.traceId ?? 'legacy',
        key,
        route: `${endpoints.source}->${endpoints.target}`,
        semanticRoute: `${event.src}->${event.dst}`,
        relationship: event.relationship,
        change: event.change,
        eventCount: event.eventCount,
        active: activeLivingFlowDiagnostics(
          state.relationshipFx.filter(candidate => candidate.key !== key),
        ),
      })
    }
    return { relationshipFx: state.relationshipFx.filter(event => event.key !== key) }
  }),

  finalizeFileDeletion: (id, key) => set((state) => {
    if (state.pendingFileDeletions[id] !== key) return state
    const { [id]: _dropped, ...restFx } = state.nodeFx
    const { [id]: _finished, ...remainingDeletions } = state.pendingFileDeletions
    return {
      files: state.files.filter(file => file.id !== id),
      dependencies: state.dependencies.filter(dep => dep.src !== id && dep.dst !== id),
      floorLayouts: state.floorLayouts.filter(layout => !(layout.nodeType === 'file' && layout.nodeId === id)),
      relationshipFx: state.relationshipFx.filter(event => event.src !== id && event.dst !== id),
      selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
      inspectedNodeId: state.inspectedNodeId === id ? null : state.inspectedNodeId,
      nodeFx: restFx,
      pendingFileDeletions: remainingDeletions,
    }
  }),

  applyDbPatch: (patch) => {
    // Sheet/annotation/canvas patches live in the sheet store (one-way dep).
    handleSheetPatch(patch as { type: string; payload: unknown })
    set((state) => {
      switch (patch.type) {
        case 'system:upserted': {
          const sys = patch.payload as DbSystem
          const exists = state.systems.some(s => s.id === sys.id)
          const systems = exists
            ? state.systems.map(s => s.id === sys.id ? sys : s)
            : [...state.systems, sys]
          // A brand-new system materializes in; an update to an existing one is
          // silent (its files carry the visible edit signal).
          if (exists) return { systems }
          const key = nextFxKey()
          scheduleFxExpiry(sys.id, key)
          return { systems, nodeFx: { ...state.nodeFx, [sys.id]: { kind: 'enter', key } } }
        }
        case 'system:deleted': {
          const { id } = patch.payload as { id: string }
          const next = new Set(state.expandedSystemIds)
          next.delete(id)
          return {
            systems: state.systems.filter(s => s.id !== id),
            expandedSystemIds: next,
          }
        }
        case 'file:updated': {
          const payload = patch.payload as DbFile | FileUpdatePatch
          const wrapped = 'file' in payload
          const file = wrapped ? payload.file : payload
          const exists = state.files.some(f => f.id === file.id)
          const files = exists
            ? state.files.map(f => f.id === file.id ? file : f)
            : [...state.files, file]
          // The watcher proves whether content changed. Attribution is
          // irrelevant: every real edit gets the same visible canvas signal.
          const fxKind = editNodeFxKind(exists, wrapped && payload.animate)
          const traceId = wrapped ? payload.traceId : undefined
          if (!fxKind) return { files }
          // A file nobody has placed does not appear on the Floor - it lands in
          // the unsorted bin. Playing the arrival on a node the canvas is not
          // drawing spends the signal on nothing, so the bin gets it instead.
          // The bin is where the file actually went, and that is what the
          // animation is for: telling you where to look.
          if (fxKind === 'enter' && !file.systemId && state.systems.length > 0) {
            return { files, unsortedArrivalKey: state.unsortedArrivalKey + 1 }
          }
          const key = nextFxKey()
          scheduleFxExpiry(file.id, key)
          return {
            files,
            nodeFx: {
              ...state.nodeFx,
              [file.id]: {
                kind: fxKind,
                key,
                traceId,
              },
            },
          }
        }
        case 'file:deleted': {
          const { id, traceId } = patch.payload as FileDeletePatch
          if (!state.files.some(file => file.id === id)) return state
          const key = nextFxKey()
          scheduleFileDeletion(id, key)
          return {
            nodeFx: { ...state.nodeFx, [id]: { kind: 'exit', key, traceId } },
            pendingFileDeletions: { ...state.pendingFileDeletions, [id]: key },
          }
        }
        case 'relationship:changed': {
          const relationship = patch.payload as LivingRelationshipChange
          const traceId = relationship.traceId ?? 'legacy'
          const visualEndpoints = livingFlowEndpoints(relationship)
          const route = `${visualEndpoints.source}->${visualEndpoints.target}`
          recordLivingFlowDiagnostic('renderer-intake', {
            traceId,
            route,
            semanticRoute: `${relationship.src}->${relationship.dst}`,
            relationship: relationship.relationship,
            change: relationship.change,
            reason: relationship.animate ? 'animate=true' : 'animate=false',
            active: activeLivingFlowDiagnostics(state.relationshipFx),
          })
          let dependencies = state.dependencies
          if (relationship.dependency && relationship.change !== 'removed') {
            const dep = relationship.dependency
            const exists = dependencies.some(item => item.id === dep.id ||
              (item.src === dep.src && item.dst === dep.dst && item.dependencyType === dep.dependencyType))
            dependencies = exists
              ? dependencies.map(item =>
                  item.id === dep.id ||
                  (item.src === dep.src && item.dst === dep.dst && item.dependencyType === dep.dependencyType)
                    ? dep : item)
              : [...dependencies, dep]
          } else if (relationship.change === 'removed' && relationship.dependencyId) {
            dependencies = dependencies.filter(item => item.id !== relationship.dependencyId)
          }
          if (!relationship.animate) {
            recordLivingFlowDiagnostic('renderer-ignored', {
              traceId,
              route,
              semanticRoute: `${relationship.src}->${relationship.dst}`,
              relationship: relationship.relationship,
              change: relationship.change,
              reason: 'animate=false',
              active: activeLivingFlowDiagnostics(state.relationshipFx),
            })
            return { dependencies }
          }
          const now = Date.now()
          // A save may report several symbol changes and more than one semantic
          // relationship for the same pair. Those updates all reach the graph
          // above, but the human sees one causal route per save. Coalescing by
          // backend trace prevents stacked pulses and stacked arrival flashes.
          // Legacy senders without a trace retain a narrow burst window.
          const duplicate = state.relationshipFx.findLast(event =>
            sameLivingSave(event, relationship, now) &&
            sameLivingRoute(event, visualEndpoints)
          )
          if (duplicate) {
            const preferIncoming =
              livingRelationshipPriority(relationship.relationship) >
              livingRelationshipPriority(duplicate.relationship)
            recordLivingFlowDiagnostic('renderer-coalesced', {
              traceId,
              key: duplicate.key,
              route,
              semanticRoute: `${relationship.src}->${relationship.dst}`,
              relationship: preferIncoming
                ? relationship.relationship
                : duplicate.relationship,
              change: mergedLivingChange(duplicate.change, relationship.change),
              eventCount: duplicate.eventCount + 1,
              reason: preferIncoming
                ? 'same-save-route/preferred-incoming'
                : 'same-save-route/retained-existing',
              active: activeLivingFlowDiagnostics(state.relationshipFx),
            })
            return {
              dependencies,
              relationshipFx: state.relationshipFx.map(event =>
                event.key === duplicate.key
                  ? {
                      ...event,
                      ...(preferIncoming ? relationship : {}),
                      change: mergedLivingChange(event.change, relationship.change),
                      key: event.key,
                      startedAt: event.startedAt,
                      delayMs: event.delayMs,
                      travelMs: event.travelMs,
                      eventCount: event.eventCount + 1,
                    }
                  : event
              ),
            }
          }
          const key = nextFxKey()
          const sameTraceFlowCount = relationship.traceId
            ? state.relationshipFx.filter(event => event.traceId === relationship.traceId).length
            : state.relationshipFx.length
          const delayMs = LIVING_FLOW_LEAD_IN_MS +
            Math.min(sameTraceFlowCount, 5) * LIVING_FLOW_STAGGER_MS
          const event: LivingRelationshipFx = {
            ...relationship,
            key,
            startedAt: now,
            delayMs,
            travelMs: LIVING_FLOW_TRAVEL_MS,
            eventCount: 1,
          }
          recordLivingFlowDiagnostic('renderer-scheduled', {
            traceId,
            key,
            route,
            semanticRoute: `${relationship.src}->${relationship.dst}`,
            relationship: relationship.relationship,
            change: relationship.change,
            eventCount: 1,
            reason: `trace-route-index=${sameTraceFlowCount}`,
            active: activeLivingFlowDiagnostics([...state.relationshipFx, event]),
            delayMs,
            travelMs: LIVING_FLOW_TRAVEL_MS,
          })
          scheduleRelationshipFxExpiry(key, delayMs)
          scheduleRelationshipArrival(
            visualEndpoints.target,
            key,
            delayMs,
            relationship.traceId,
          )
          return {
            dependencies,
            relationshipFx: [...state.relationshipFx, event],
          }
        }
        case 'file:assigned': {
          const { fileId, systemId } = patch.payload as { fileId: string; systemId: string }
          return {
            files: state.files.map(f => f.id === fileId ? { ...f, systemId } : f),
          }
        }
        case 'infra:upserted': {
          const node = patch.payload as DbInfraNode
          const exists = state.infraNodes.some(n => n.id === node.id)
          const infraNodes = exists
            ? state.infraNodes.map(n => n.id === node.id ? node : n)
            : [...state.infraNodes, node]
          if (exists) return { infraNodes }
          const key = nextFxKey()
          scheduleFxExpiry(node.id, key)
          return { infraNodes, nodeFx: { ...state.nodeFx, [node.id]: { kind: 'enter', key } } }
        }
        case 'infra:deleted': {
          const { id } = patch.payload as { id: string }
          return {
            infraNodes: state.infraNodes.filter(n => n.id !== id),
            // the daemon's trigger removed the edges; mirror that locally
            dependencies: state.dependencies.filter(d => d.src !== id && d.dst !== id),
          }
        }
        case 'infra:connected': {
          const dep = patch.payload as DbDependency
          const exists = state.dependencies.some(d => d.id === dep.id ||
            (d.src === dep.src && d.dst === dep.dst && d.dependencyType === dep.dependencyType))
          return {
            dependencies: exists
              ? state.dependencies.map(d =>
                  (d.id === dep.id || (d.src === dep.src && d.dst === dep.dst && d.dependencyType === dep.dependencyType)) ? dep : d)
              : [...state.dependencies, dep],
          }
        }
        case 'infra:disconnected': {
          const { id } = patch.payload as { id: string }
          return { dependencies: state.dependencies.filter(d => d.id !== id) }
        }
        case 'floor:layouts': {
          const { layouts } = patch.payload as { revision: number; layouts: FloorLayout[] }
          const changed = new Set(layouts.map(layout => `${layout.nodeType}:${layout.nodeId}`))
          const byKey = new Map(layouts.map(layout => [`${layout.nodeType}:${layout.nodeId}`, layout]))
          return {
            floorLayouts: [
              ...state.floorLayouts.filter(layout => !changed.has(`${layout.nodeType}:${layout.nodeId}`)),
              ...layouts,
            ],
            systems: state.systems.map(system => {
              const layout = byKey.get(`system:${system.id}`)
              return layout && layout.containmentKind !== 'hosted_by'
                ? { ...system, parentId: layout.parentNodeId }
                : system
            }),
            files: state.files.map(file => {
              const layout = byKey.get(`file:${file.id}`)
              return layout && layout.containmentKind !== 'hosted_by'
                ? { ...file, systemId: layout.parentNodeId }
                : file
            }),
          }
        }
        default:
          return state
      }
    })
  },

  toggleSystemExpanded: (id) => set((state) => {
    const next = new Set(state.expandedSystemIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { expandedSystemIds: next }
  }),

  collapseAll: () => set((state) =>
    state.expandedSystemIds.size === 0 ? state : { expandedSystemIds: new Set() }
  ),

  setSelectedNode: (id) => set({ selectedNodeId: id }),
  setInspectedNode: (id) => set({ inspectedNodeId: id }),
  setInfraPickerNode: (id) => set({ infraPickerNodeId: id }),

  setIndexingProgress: (progress) => set({
    indexingProgress: progress,
    isIndexing: progress !== null,
  }),

  // Project registration starts indexing before the first progress event can
  // arrive. Mark that boundary explicitly so a large raw snapshot cannot be
  // painted as a temporary file-only Floor in the gap.
  beginIndexing: () => set({ indexingProgress: null, isIndexing: true }),

  setIndexingComplete: () => set({ indexingProgress: null, isIndexing: false }),

  setConnectionStatus: (s) => set({ connectionStatus: s }),

  setSelectionMode: (active) => set({ selectionMode: active }),
  documentsOpen: false,
  setDocumentsOpen: (open) => set({ documentsOpen: open }),
  unsortedArrivalKey: 0,

  getFile: (id) => get().files.find(f => f.id === id),
  getSystem: (id) => get().systems.find(s => s.id === id),
}))

// ─── Runtime helpers ─────────────────────────────────────────────────────────

function emptyNodeState(): RuntimeNodeState {
  return {
    watchedSymbols: [], callCount: 0, pulseKey: 0, lastKind: null,
    lastLabel: '', rateLimited: false, injection: null, verdict: null,
    lastSymbol: '', lastArgs: '', lastReturn: '', lastException: '',
  }
}

function nodeSymbols(watches: Record<string, RuntimeWatch>, fileId: string): string[] {
  return Object.values(watches).filter(w => w.fileId === fileId).map(w => w.symbol)
}

/** Recompute each file's watched symbols after the watch set changes,
 *  pruning node state for files that no longer have any watch. */
function rebuildNodeWatches(
  nodes: Record<string, RuntimeNodeState>,
  watches: Record<string, RuntimeWatch>,
): Record<string, RuntimeNodeState> {
  const out: Record<string, RuntimeNodeState> = {}
  const fileIds = new Set(Object.values(watches).map(w => w.fileId))
  for (const fileId of fileIds) {
    const prev = nodes[fileId] ?? emptyNodeState()
    out[fileId] = { ...prev, watchedSymbols: nodeSymbols(watches, fileId) }
  }
  return out
}

function formatArgs(args?: Record<string, RuntimeValue>): string {
  if (!args) return ''
  return Object.entries(args).map(([k, v]) => `${k}=${v.value}`).join(', ')
}

function eventLabel(ev: RuntimeEvent): string {
  switch (ev.kind) {
    case 'call':      return `${ev.symbol}(${formatArgs(ev.args)})`
    case 'return':    return `${ev.symbol} → ${ev.returnValue?.value ?? 'None'}`
    case 'exception': return `${ev.symbol} ✗ ${ev.excType}: ${ev.message}`
    case 'rate_limit': return `${ev.symbol} rate-limited (watch auto-disabled)`
  }
}

// Live-choreography key: monotonic so a repeat edit on the same node bumps the
// key and re-fires its animation. Expiry removes the intent after the animation
// window so the node returns to rest (a newer intent supersedes an older one).
let fxKeyCounter = 0
function nextFxKey(): number { return ++fxKeyCounter }
export const LIVING_FLOW_TRAVEL_MS = 1250
export const LIVING_FLOW_STAGGER_MS = 90
export const LIVING_FLOW_LEAD_IN_MS = 240
// The destination surfaces only when the travelling segment reaches the
// destination perimeter. Revealing it earlier reads like the flow jumped from
// the edge into the middle of the card.
export const LIVING_FLOW_ARRIVAL_FRACTION = 0.96
export const LIVING_NODE_SIGNAL_MS = 1900
export const LIVING_ARRIVAL_MS = 1350
// Exit durations are the single source of truth for both the unmount timer and
// the CSS fade: the components publish them as custom properties, so the
// stylesheet can never drift out of sync and unmount an element mid-fade. The
// aperture outlasts the card inside it so the window is the last thing to close.
export const LIVING_FILE_SIGNAL_CLOSE_MS = 340
export const LIVING_WINDOW_CLOSE_MS = 440
// A deleted file has to outlive its own severed relationships: archd emits the
// fuse flows before the tombstone, and they radiate outward from this node. The
// card must stay solid while they burn and dissolve exactly as it unmounts,
// which is why the node's red exit animation is driven by this same number.
export const LIVING_FILE_DELETE_MS =
  LIVING_FLOW_TRAVEL_MS + LIVING_FLOW_STAGGER_MS * 5 + 250

function sameLivingSave(
  event: LivingRelationshipFx,
  incoming: LivingRelationshipChange,
  now: number,
): boolean {
  if (incoming.traceId) return event.traceId === incoming.traceId
  return !event.traceId && now - event.startedAt <= 140
}

function sameLivingRoute(
  event: LivingRelationshipFx,
  incomingEndpoints: { source: string; target: string },
): boolean {
  const existingEndpoints = livingFlowEndpoints(event)
  return existingEndpoints.source === incomingEndpoints.source &&
    existingEndpoints.target === incomingEndpoints.target
}

function livingRelationshipPriority(relationship: string): number {
  if (relationship === 'CALLS') return 3
  if (relationship === 'IMPORTS') return 2
  return 1
}

function mergedLivingChange(
  existing: LivingRelationshipChange['change'],
  incoming: LivingRelationshipChange['change'],
): LivingRelationshipChange['change'] {
  return existing === incoming ? existing : 'updated'
}

function scheduleFxExpiry(id: string, key: number, durationMs = LIVING_NODE_SIGNAL_MS): void {
  setTimeout(() => useGraphStore.getState().clearNodeFx(id, key), durationMs)
}
function scheduleRelationshipFxExpiry(key: number, delayMs = 0): void {
  setTimeout(
    () => useGraphStore.getState().clearRelationshipFx(key),
    delayMs + LIVING_FLOW_TRAVEL_MS + 250,
  )
}
function scheduleRelationshipArrival(
  id: string,
  key: number,
  delayMs: number,
  traceId?: string,
): void {
  setTimeout(() => {
    useGraphStore.setState((state) => {
      const event = state.relationshipFx.find(event => event.key === key)
      if (!event) {
        recordLivingFlowDiagnostic('renderer-arrival-skipped', {
          traceId: traceId ?? 'legacy',
          key,
          reason: 'flow-no-longer-active',
          active: activeLivingFlowDiagnostics(state.relationshipFx),
        })
        return state
      }
      const endpoints = livingFlowEndpoints(event)
      if (state.pendingFileDeletions[id] !== undefined) {
        recordLivingFlowDiagnostic('renderer-arrival-skipped', {
          traceId: event.traceId ?? traceId ?? 'legacy',
          key,
          route: `${endpoints.source}->${endpoints.target}`,
          semanticRoute: `${event.src}->${event.dst}`,
          relationship: event.relationship,
          change: event.change,
          reason: 'target-pending-deletion',
          active: activeLivingFlowDiagnostics(state.relationshipFx),
        })
        return state
      }
      const kind = relationshipVisual(event).targetKind
      recordLivingFlowDiagnostic('renderer-arrival', {
        traceId: event.traceId ?? traceId ?? 'legacy',
        key,
        route: `${endpoints.source}->${endpoints.target}`,
        semanticRoute: `${event.src}->${event.dst}`,
        relationship: event.relationship,
        change: event.change,
        eventCount: event.eventCount,
        reason: `target=${id};kind=${kind}`,
        active: activeLivingFlowDiagnostics(state.relationshipFx),
      })
      return { nodeFx: { ...state.nodeFx, [id]: { kind, key, traceId } } }
    })
    scheduleFxExpiry(id, key, LIVING_ARRIVAL_MS)
  }, delayMs + LIVING_FLOW_TRAVEL_MS * LIVING_FLOW_ARRIVAL_FRACTION)
}
function scheduleFileDeletion(id: string, key: number): void {
  // Relationship removals are broadcast before the tombstone. Keep the
  // endpoint in the React Flow model until the longest staggered exit has
  // completed, while pendingFileDeletions independently guarantees cleanup.
  setTimeout(
    () => useGraphStore.getState().finalizeFileDeletion(id, key),
    LIVING_FILE_DELETE_MS,
  )
}

// Runtime events can arrive at up to 100/sec per watch. Batch them and flush
// on a short interval so the canvas re-renders at most ~12 times per second.
let pendingRuntimeEvents: RuntimeEvent[] = []
let runtimeFlushTimer: ReturnType<typeof setTimeout> | null = null
let dataFlowClearTimer: ReturnType<typeof setTimeout> | null = null
let traceClearTimer: ReturnType<typeof setTimeout> | null = null

function queueRuntimeEvent(ev: RuntimeEvent): void {
  pendingRuntimeEvents.push(ev)
  if (runtimeFlushTimer === null) {
    runtimeFlushTimer = setTimeout(() => {
      const batch = pendingRuntimeEvents
      pendingRuntimeEvents = []
      runtimeFlushTimer = null
      useGraphStore.getState().applyRuntimeEvents(batch)
    }, 80)
  }
}

// ─── WebSocket connection ────────────────────────────────────────────────────

let ws: WebSocket | null = null
// Each connectToArchd call invalidates previous sockets' reconnect loops -
// otherwise every remount would spawn another loop that reconnects forever.
let wsGeneration = 0

export function connectToArchd(wsUrl = 'ws://127.0.0.1:7744/ws'): void {
  const generation = ++wsGeneration
  if (ws) {
    try { ws.close() } catch { /* already closed */ }
    ws = null
  }
  const store = useGraphStore.getState()
  store.setConnectionStatus('connecting')

  const tryConnect = () => {
    if (generation !== wsGeneration) return
    const socket = new WebSocket(wsUrl)
    let lastSeq: number | null = null
    let resyncing = false
    let buffered: Array<{ type: string; payload: unknown; seq?: number }> = []

    const resyncSnapshot = async (reason: string) => {
      if (resyncing || generation !== wsGeneration) return
      const workspaceId = useGraphStore.getState().currentProject?.id
      if (!workspaceId) return
      resyncing = true
      try {
        const response = await fetch(`http://127.0.0.1:7743/api/snapshot/${workspaceId}`)
        if (!response.ok) throw new Error(`snapshot ${response.status}`)
        useGraphStore.getState().applySnapshot(await response.json() as CanvasSnapshot)
        const pending = buffered
        buffered = []
        resyncing = false
        for (const message of pending) handleWsMessage(message)
      } catch (error) {
        console.error(`[ws] ${reason} resync failed:`, error)
        resyncing = false
        socket.close()
      }
    }
    ws = socket

    socket.onopen = () => {
      if (generation !== wsGeneration) return
      useGraphStore.getState().setConnectionStatus('connected')
      void resyncSnapshot('connection')
    }

    socket.onmessage = (event) => {
      if (generation !== wsGeneration) return
      try {
        const msg = JSON.parse(event.data) as { type: string; payload: unknown; seq?: number }
        const sequenceGap = typeof msg.seq === 'number' &&
          lastSeq !== null &&
          msg.seq !== lastSeq + 1
        if (typeof msg.seq === 'number') lastSeq = msg.seq
        if (sequenceGap) {
          console.warn('[ws] message sequence gap; restoring graph snapshot', { received: msg.seq })
          buffered.push(msg)
          void resyncSnapshot('sequence-gap')
          return
        }
        if (resyncing) {
          buffered.push(msg)
          return
        }
        handleWsMessage(msg)
      } catch {
        console.error('ws: failed to parse message', event.data)
      }
    }

    socket.onclose = () => {
      if (generation !== wsGeneration) return
      useGraphStore.getState().setConnectionStatus('disconnected')
      setTimeout(tryConnect, 2000)
    }

    socket.onerror = () => socket.close()
  }

  tryConnect()
}

// While a replay is loaded, live runtime/trace/flow/note events are ignored so
// they don't clobber the played-back frame. Replay's own dispatches set this
// flag so they pass through.
let replayDispatching = false
const LIVE_GATED_TYPES = new Set([
  'runtime:call', 'runtime:return', 'runtime:exception', 'runtime:rate_limit',
  'runtime:watch', 'runtime:unwatch', 'runtime:session', 'runtime:inject',
  'runtime:inject_pending', 'call:trace', 'data:flow', 'agent:activity',
  'investigation:note',
])

function dispatchReplayEvent(ev: CapturedEvent): void {
  replayDispatching = true
  try {
    handleWsMessage({ type: ev.type, payload: ev.payload })
  } finally {
    replayDispatching = false
  }
}

export function handleWsMessage(msg: { type: string; payload: unknown }): void {
  const store = useGraphStore.getState()
  // Gate live dynamic events during replay (graph/indexing events still apply).
  if (store.replay && !replayDispatching && LIVE_GATED_TYPES.has(msg.type)) {
    return
  }
  switch (msg.type) {
    case 'graph:snapshot':
      store.applySnapshot(msg.payload as CanvasSnapshot)
      break
    case 'classification:updated':
      store.applyClassification(msg.payload as CanvasSnapshot)
      break
    case 'graph:patch':
      store.applyDbPatch(msg.payload as DbGraphPatch)
      break
    case 'indexing:progress':
      store.setIndexingProgress(msg.payload as { indexed: number; total: number })
      break
    case 'indexing:complete':
      store.setIndexingComplete()
      break
    // archd has finished baseline/reconciliation, so the journal is settled
    // and the Morning Delta can be read without racing the catch-up pass.
    case 'delta:ready':
      // Existing projects reconcile instead of running the full indexer, so
      // they do not emit indexing:complete. delta:ready is the shared terminal
      // event for both paths and closes the explicit beginIndexing boundary.
      store.setIndexingComplete()
      void store.loadDelta()
      break
    case 'agent:action':
      store.applyAgentAction(msg.payload as AgentAction)
      break
    case 'work:session':
      store.applyWorkSession(msg.payload as DeltaWorkSession)
      break
    case 'agent:activity':
      store.addAgentActivity(msg.payload as { message: string; level: 'info' | 'warn' | 'success' | 'error' })
      break
    case 'data:flow': {
      const { variable, fileIds } = msg.payload as { variable: string; fileIds: string[] }
      store.setDataFlow({ variable, fileIds: fileIds ?? [] })
      store.addAgentActivity({
        message: `Data-flow slice: "${variable}" spans ${fileIds?.length ?? 0} file(s)`,
        level: 'info',
      })
      // Auto-clear the overlay after 30s so it doesn't linger.
      if (dataFlowClearTimer) clearTimeout(dataFlowClearTimer)
      dataFlowClearTimer = setTimeout(() => {
        const cur = useGraphStore.getState().dataFlow
        if (cur && cur.variable === variable) useGraphStore.getState().setDataFlow(null)
        dataFlowClearTimer = null
      }, 30_000)
      break
    }
    case 'call:trace': {
      const { steps } = msg.payload as { steps: CallTraceStep[] }
      store.setActiveTrace(steps ?? null)
      // Auto-clear after 30 seconds so the trace doesn't linger forever
      if (traceClearTimer) clearTimeout(traceClearTimer)
      traceClearTimer = setTimeout(() => {
        if (useGraphStore.getState().activeTrace === steps) {
          useGraphStore.getState().setActiveTrace(null)
        }
        traceClearTimer = null
      }, 30_000)
      break
    }

    // ── Runtime layer ──────────────────────────────────────────────────────
    case 'runtime:session': {
      const { session, status } = msg.payload as { session: RuntimeSession; status: 'connected' | 'disconnected' }
      store.applyRuntimeSession(session, status)
      store.addAgentActivity({
        message: status === 'connected'
          ? `Runtime adapter connected: ${session.language} (pid ${session.pid})`
          : `Runtime adapter disconnected (pid ${session.pid})`,
        level: status === 'connected' ? 'success' : 'warn',
      })
      break
    }
    case 'runtime:watch': {
      const { watch } = msg.payload as { watch: RuntimeWatch }
      store.applyRuntimeWatch(watch)
      break
    }
    case 'runtime:unwatch': {
      const { watch } = msg.payload as { watch: RuntimeWatch }
      store.removeRuntimeWatch(watch)
      break
    }
    case 'runtime:call':
    case 'runtime:return':
    case 'runtime:exception':
    case 'runtime:rate_limit': {
      const ev = msg.payload as RuntimeEvent
      if (ev.kind === 'rate_limit') {
        store.addAgentActivity({
          message: `Watch on ${ev.symbol} (${ev.relPath}) auto-disabled: >100 calls/sec`,
          level: 'warn',
        })
      }
      queueRuntimeEvent(ev)
      break
    }
    case 'runtime:inject_pending': {
      const { inject } = msg.payload as { inject: RuntimeInjection }
      store.applyRuntimeInject(inject)
      store.addAgentActivity({
        message: `⚠ Agent wants to inject ${inject.paramName}=${JSON.stringify(inject.value)} into ${inject.symbol} (${inject.relPath}) - confirm on canvas`,
        level: 'warn',
      })
      break
    }
    case 'runtime:inject': {
      const { inject } = msg.payload as { inject: RuntimeInjection }
      store.applyRuntimeInject(inject)
      if (inject.status === 'fired') {
        store.addAgentActivity({
          message: `Injection fired: ${inject.symbol}(${inject.paramName}: ${inject.originalValue?.value ?? '?'} → ${inject.injectedValue?.value ?? '?'})`,
          level: 'warn',
        })
      } else if (inject.status === 'error') {
        store.addAgentActivity({ message: `Injection failed: ${inject.error}`, level: 'error' })
      }
      break
    }
    case 'runtime:target_start': {
      const { target } = msg.payload as { target: { command: string[]; pid: number } }
      store.addAgentActivity({
        message: `Target launched: ${target.command.join(' ')} (pid ${target.pid})`,
        level: 'success',
      })
      break
    }
    case 'runtime:target_exit': {
      const { exitCode } = msg.payload as { exitCode: number }
      store.addAgentActivity({ message: `Target exited with code ${exitCode}`, level: exitCode === 0 ? 'info' : 'error' })
      break
    }
  }
}
