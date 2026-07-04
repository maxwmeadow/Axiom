import { create } from 'zustand'
import type {
  ProjectConfig,
  DbSystem,
  DbFile,
  DbInfraNode,
  DbDependency,
  CanvasSnapshot,
  DbGraphPatch,
} from '../../shared/types'

export interface CallTraceStep {
  callerFile: string
  callerSymbol: string
  calleeFile: string
  calleeSymbol: string
  callCount: number
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
  /** Incremented on every call — remounts the pulse ring to replay the animation. */
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

  // Canvas expand/collapse state
  expandedSystemIds: Set<string>

  // UI state
  selectedNodeId: string | null
  agentTouchedIds: Set<string>
  indexingProgress: { indexed: number; total: number } | null
  isIndexing: boolean
  connectionStatus: 'disconnected' | 'connecting' | 'connected'
  selectionMode: boolean
  agentActivities: { message: string; level: 'info' | 'warn' | 'success' | 'error'; timestamp: number }[]
  addAgentActivity: (activity: { message: string; level: 'info' | 'warn' | 'success' | 'error' }) => void
  clearAgentActivities: () => void

  // Call trace — set when an agent queries a call path; cleared after timeout or new trace
  activeTrace: CallTraceStep[] | null
  setActiveTrace: (trace: CallTraceStep[] | null) => void

  // Data-flow slice — set of file IDs in the current variable-reference slice
  dataFlow: { variable: string; fileIds: Set<string> } | null
  setDataFlow: (flow: { variable: string; fileIds: string[] } | null) => void

  // Runtime layer — live sessions, watches, per-file activity
  runtimeSessions: RuntimeSession[]
  runtimeWatches: Record<string, RuntimeWatch>
  runtimeNodes: Record<string, RuntimeNodeState>
  runtimeInjections: Record<string, RuntimeInjection>
  applyRuntimeSession: (session: RuntimeSession, status: 'connected' | 'disconnected') => void
  applyRuntimeWatch: (watch: RuntimeWatch) => void
  removeRuntimeWatch: (watch: RuntimeWatch) => void
  applyRuntimeEvents: (events: RuntimeEvent[]) => void
  applyRuntimeInject: (inject: RuntimeInjection) => void

  // Investigation replay (Phase 8) — re-feeds captured events through the live
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
  applyDbPatch: (patch: DbGraphPatch) => void
  toggleSystemExpanded: (id: string) => void
  collapseAll: () => void
  setSelectedNode: (id: string | null) => void
  setIndexingProgress: (progress: { indexed: number; total: number } | null) => void
  setIndexingComplete: () => void
  setConnectionStatus: (s: 'disconnected' | 'connecting' | 'connected') => void
  setSelectionMode: (active: boolean) => void
  getFile: (id: string) => DbFile | undefined
  getSystem: (id: string) => DbSystem | undefined
  searchFiles: (query: string) => DbFile[]
}

export const useGraphStore = create<GraphState>((set, get) => ({
  currentProject: null,
  recentProjects: [],
  systems: [],
  files: [],
  infraNodes: [],
  dependencies: [],
  expandedSystemIds: new Set(),
  selectedNodeId: null,
  agentTouchedIds: new Set(),
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
      // Verdict: an event inside a perturbed subtree colors this node —
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
      // A newly armed injection starts a fresh experiment — clear the verdict.
      verdict: inject.status === 'armed' ? null : prev.verdict,
    }
    return { runtimeInjections: injections, runtimeNodes: nodes }
  }),

  setCurrentProject: (p) => set({ currentProject: p }),
  setRecentProjects: (ps) => set({ recentProjects: ps }),

  applySnapshot: (snap) => set({
    systems: snap.systems ?? [],
    files: snap.files ?? [],
    infraNodes: snap.infraNodes ?? [],
    dependencies: snap.dependencies ?? [],
    // Start with all top-level systems collapsed
    expandedSystemIds: new Set(),
  }),

  applyDbPatch: (patch) => set((state) => {
    switch (patch.type) {
      case 'system:upserted': {
        const sys = patch.payload as DbSystem
        const exists = state.systems.some(s => s.id === sys.id)
        return {
          systems: exists
            ? state.systems.map(s => s.id === sys.id ? sys : s)
            : [...state.systems, sys],
        }
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
        const file = patch.payload as DbFile
        const exists = state.files.some(f => f.id === file.id)
        return {
          files: exists
            ? state.files.map(f => f.id === file.id ? file : f)
            : [...state.files, file],
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
        return {
          infraNodes: exists
            ? state.infraNodes.map(n => n.id === node.id ? node : n)
            : [...state.infraNodes, node],
        }
      }
      default:
        return state
    }
  }),

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

  setIndexingProgress: (progress) => set({
    indexingProgress: progress,
    isIndexing: progress !== null,
  }),

  setIndexingComplete: () => set({ indexingProgress: null, isIndexing: false }),

  setConnectionStatus: (s) => set({ connectionStatus: s }),

  setSelectionMode: (active) => set({ selectionMode: active }),

  getFile: (id) => get().files.find(f => f.id === id),
  getSystem: (id) => get().systems.find(s => s.id === id),

  searchFiles: (query) => {
    const q = query.toLowerCase()
    return get().files
      .filter(f => f.relPath.toLowerCase().includes(q))
      .slice(0, 30)
  },
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

// Runtime events can arrive at up to 100/sec per watch. Batch them and flush
// on a short interval so the canvas re-renders at most ~12 times per second.
let pendingRuntimeEvents: RuntimeEvent[] = []
let runtimeFlushTimer: ReturnType<typeof setTimeout> | null = null

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
// Each connectToArchd call invalidates previous sockets' reconnect loops —
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
    ws = socket

    socket.onopen = () => {
      if (generation !== wsGeneration) return
      useGraphStore.getState().setConnectionStatus('connected')
    }

    socket.onmessage = (event) => {
      if (generation !== wsGeneration) return
      try {
        const msg = JSON.parse(event.data) as { type: string; payload: unknown }
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
    case 'graph:patch':
      store.applyDbPatch(msg.payload as DbGraphPatch)
      break
    case 'indexing:progress':
      store.setIndexingProgress(msg.payload as { indexed: number; total: number })
      break
    case 'indexing:complete':
      store.setIndexingComplete()
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
      setTimeout(() => {
        const cur = useGraphStore.getState().dataFlow
        if (cur && cur.variable === variable) useGraphStore.getState().setDataFlow(null)
      }, 30_000)
      break
    }
    case 'call:trace': {
      const { steps } = msg.payload as { steps: CallTraceStep[] }
      store.setActiveTrace(steps ?? null)
      // Auto-clear after 30 seconds so the trace doesn't linger forever
      setTimeout(() => {
        if (useGraphStore.getState().activeTrace === steps) {
          useGraphStore.getState().setActiveTrace(null)
        }
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
        message: `⚠ Agent wants to inject ${inject.paramName}=${JSON.stringify(inject.value)} into ${inject.symbol} (${inject.relPath}) — confirm on canvas`,
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
