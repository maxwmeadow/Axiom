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

// ─── WebSocket connection ────────────────────────────────────────────────────

let ws: WebSocket | null = null

export function connectToArchd(wsUrl = 'ws://127.0.0.1:7744/ws'): void {
  const store = useGraphStore.getState()
  store.setConnectionStatus('connecting')

  const tryConnect = () => {
    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      useGraphStore.getState().setConnectionStatus('connected')
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as { type: string; payload: unknown }
        handleWsMessage(msg)
      } catch {
        console.error('ws: failed to parse message', event.data)
      }
    }

    ws.onclose = () => {
      useGraphStore.getState().setConnectionStatus('disconnected')
      setTimeout(tryConnect, 2000)
    }

    ws.onerror = () => ws?.close()
  }

  tryConnect()
}

export function handleWsMessage(msg: { type: string; payload: unknown }): void {
  const store = useGraphStore.getState()
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
  }
}
