// Sheets — curated diagrams over the live model (UML_UX_PLAN.md U1) plus the
// canvas→agent message channel (U-C). The Floor (live master canvas) is
// activeSheetId === null.
import { create } from 'zustand'
import type { FloorLayout } from '../../shared/types'
import { raiseFailure } from './interruptionStore.ts'

const API = 'http://127.0.0.1:7743'
let openSheetRequest = 0
let fetchSheetsRequest = 0
let sheetLayoutWriteSequence = 0
const pendingSheetLayoutWrites = new Map<string, number>()
// Optimistic state can advance immediately, but persistence for one sheet must
// reach the daemon in gesture order. Otherwise a slow older request can commit
// after a newer drag and broadcast stale geometry at a higher revision.
const sheetLayoutSaveQueues = new Map<string, Promise<void>>()

// archd refuses with {"error": "..."}. Surface that sentence — it is written for
// a person to read — and fall back to the status only when there isn't one.
async function refusalReason(res: Response, fallback: string): Promise<string> {
  const raw = (await res.text()).trim()
  try {
    const parsed = JSON.parse(raw) as { error?: string }
    if (parsed?.error) return parsed.error
  } catch {
    // Not JSON — a proxy or crash page. The raw text is still the best clue.
  }
  return raw || `${fallback} (${res.status})`
}

export interface Sheet {
  id: string
  workspaceId: string
  name: string
  purpose: string | null
  kind: 'structure' | 'class' | 'sequence' | 'intent'
  folder: string
  createdBy: 'user' | 'agent'
  revision: number
  viewport?: { x: number; y: number; zoom: number }
  createdAt: number
  updatedAt: number
}

export interface SheetElement {
  id: string
  sheetId: string
  systemId: string | null
  fileId: string | null
  infraId: string | null
  symbolRef: string | null
  label: string
  positionX: number
  positionY: number
  width?: number | null
  height?: number | null
  scale?: number
  parentSystemId: string | null
  tombstoneAck: number
  designMetadata?: PlannedNodeMetadata | string
  ghost: number
  addedBy: string
}

export interface SheetAnnotation {
  id: string
  workspaceId: string
  sheetId: string | null
  targetType: string | null
  targetId: string | null
  body: string
  kind: 'note' | 'flag' | 'decision' | 'reply'
  author: 'user' | 'agent'
  positionX: number | null
  positionY: number | null
  createdAt: number
}

export interface CanvasMessage {
  id: string
  workspaceId: string
  sheetId: string | null
  note: string
  selection: string
  changeSummary: string
  sheetContext: string
  buildSpec: string
  status: 'queued' | 'delivered' | 'answered'
  deliveredTo: string | null
  answerAnnotationId: string | null
  createdAt: number
}

export type PlannedNodeKind = 'system' | 'class' | 'file' | 'service' | 'data_store' | 'infra'
export type UmlVisibility = 'public' | 'private' | 'protected' | 'package'

export interface UmlParameter {
  name: string
  dataType: string
}

export interface UmlAttribute {
  visibility: UmlVisibility
  name: string
  dataType: string
}

export interface UmlMethod {
  visibility: UmlVisibility
  name: string
  parameters: UmlParameter[]
  returnType: string
}

/**
 * Structured authoring details carried by a node when a Sheet is sent to an
 * agent. Rows are metadata, not independent graph entities.
 */
export interface PlannedNodeMetadata {
  version: 1
  stereotype?: string
  classKind?: 'class' | 'interface' | 'abstract'
  role?: string
  description?: string
  path?: string
  language?: string
  attributes?: UmlAttribute[]
  methods?: UmlMethod[]
  exports?: string[]
  technology?: string
  entities?: string[]
  protocol?: string
  address?: string
  endpoints?: UmlMethod[]
  category?: string
  provider?: string
  service?: string
  subtype?: string
  configuration?: string[]
  config?: Record<string, string>
  environmentVariables?: Record<string, string>
  tables?: Array<{ name: string; schema?: string }>
  symbols?: Array<{ name: string; kind: string }>
  capabilities?: string[]
}

export interface PlannedMember {
  signature: string
  intent?: string
  realized: boolean
}

export interface PlannedNode {
  id: string
  sheetId: string
  workspaceId: string
  kind: PlannedNodeKind
  name: string
  declaredPath: string
  members: PlannedMember[] | string   // server sends json; normalize on read
  metadata: PlannedNodeMetadata | string
  status: 'planned' | 'partial' | 'realized' | 'flattened'
  approvalStatus: 'pending' | 'approved' | 'rejected'
  realizedFileId: string | null
  notes: string
  shape: '' | 'box' | 'folder' | 'cylinder' | 'hexagon'
  color: string
  positionX: number
  positionY: number
  width?: number | null
  height?: number | null
  scale?: number
  parentSystemId: string | null
  createdBy: string
}

export interface PlannedEdge {
  id: string
  sheetId: string
  kind: 'CALLS' | 'DEPENDS_ON' | 'CONTAINS'
  srcPlanned: string | null
  srcLive: string | null
  dstPlanned: string | null
  dstLive: string | null
  note: string
}

/** Proposal-local geometry. Aside from sheetId, this is exactly FloorLayout. */
export interface SheetLayout extends FloorLayout {
  sheetId: string
}

/** A complete canonical row; identity/timestamps are supplied by the API. */
export type SheetLayoutMutation = Omit<SheetLayout, 'sheetId' | 'workspaceId' | 'updatedAt'>

export function plannedMembers(n: PlannedNode): PlannedMember[] {
  if (Array.isArray(n.members)) return n.members
  try { return JSON.parse(n.members || '[]') } catch { return [] }
}

export function defaultPlannedMetadata(kind: PlannedNodeKind): PlannedNodeMetadata {
  const common: PlannedNodeMetadata = { version: 1 }
  switch (kind) {
    case 'class': return { ...common, attributes: [], methods: [] }
    case 'file': return { ...common, exports: [] }
    case 'service': return { ...common, protocol: 'HTTP', endpoints: [] }
    case 'data_store': return { ...common, entities: [] }
    case 'infra': return { ...common, category: 'api', provider: 'generic', configuration: [] }
    case 'system': return common
  }
}

export function plannedMetadata(n: PlannedNode): PlannedNodeMetadata {
  let parsed: PlannedNodeMetadata | null = null
  if (typeof n.metadata === 'object' && n.metadata !== null) parsed = n.metadata
  if (typeof n.metadata === 'string' && n.metadata) {
    try { parsed = JSON.parse(n.metadata) as PlannedNodeMetadata } catch { /* use defaults */ }
  }
  const metadata = { ...defaultPlannedMetadata(n.kind), ...(parsed ?? {}), version: 1 as const }
  if ((n.kind === 'class' || n.kind === 'file') && metadata.path === undefined) {
    metadata.path = n.declaredPath
  }
  // Preserve pre-metadata authored members as editable class/file methods.
  if (n.kind === 'class' && (!metadata.methods || metadata.methods.length === 0)) {
    const legacy = plannedMembers(n)
    if (legacy.length > 0) {
      metadata.methods = legacy.map(member => ({
        visibility: 'public', name: member.signature, parameters: [], returnType: '',
      }))
    }
  }
  return metadata
}

export function sheetElementMetadata(element: SheetElement): PlannedNodeMetadata | undefined {
  const raw = element.designMetadata
  if (typeof raw === 'object' && raw !== null) return { ...raw, version: 1 }
  if (typeof raw === 'string' && raw) {
    try { return { ...(JSON.parse(raw) as PlannedNodeMetadata), version: 1 } } catch { /* invalid legacy metadata */ }
  }
  return undefined
}

export interface SheetLayerData {
  sheet: Sheet
  elements: SheetElement[]
  annotations: SheetAnnotation[]
  planned: PlannedNode[]
  plannedEdges: PlannedEdge[]
  layouts: SheetLayout[]
}

function withValidScale<T extends { scale?: number }>(item: T): T {
  return Number.isFinite(item.scale) && Number(item.scale) > 0
    ? item
    : { ...item, scale: 1 }
}

async function fetchSheetLayer(workspaceId: string, sheetId: string): Promise<SheetLayerData | null> {
  const res = await fetch(`${API}/api/sheets/${encodeURIComponent(sheetId)}?workspace=${encodeURIComponent(workspaceId)}`)
  if (!res.ok) return null
  const data = await res.json() as SheetLayerData
  return {
    sheet: data.sheet,
    elements: (data.elements ?? []).map(withValidScale),
    annotations: data.annotations ?? [],
    planned: (data.planned ?? []).map(withValidScale),
    plannedEdges: data.plannedEdges ?? [],
    layouts: data.layouts ?? [],
  }
}

interface SheetState {
  workspaceId: string | null
  sheets: Sheet[]
  activeSheetId: string | null           // null = The Floor (base layer only)
  visibleSheetIds: string[]              // bottom-to-top; primary always resolves last
  layersById: Record<string, SheetLayerData>
  elements: SheetElement[]               // active sheet's members
  annotations: SheetAnnotation[]         // active sheet's notes
  planned: PlannedNode[]                 // active sheet's planned elements
  plannedEdges: PlannedEdge[]
  layouts: SheetLayout[]                 // active sheet's canonical geometry opinions
  messages: CanvasMessage[]              // recent canvas→agent messages (chips)

  fetchSheets: (workspaceId: string) => Promise<void>
  openSheet: (workspaceId: string, sheetId: string | null) => Promise<void>
  toggleSheetVisibility: (workspaceId: string, sheetId: string) => Promise<void>
  createSheet: (workspaceId: string, name: string, purpose: string, fileIds: string[]) => Promise<Sheet>
  deleteSheet: (workspaceId: string, sheetId: string) => Promise<void>
  previewElementPosition: (elementId: string, x: number, y: number) => void
  updateElementLayout: (workspaceId: string, elementId: string, x: number, y: number, parentSystemId: string | null, width?: number, height?: number, scale?: number) => void
  updateElementMetadata: (workspaceId: string, elementId: string, metadata: PlannedNodeMetadata) => Promise<void>
  removeElement: (workspaceId: string, sheetId: string, elementId: string) => Promise<void>
  sendToAgent: (workspaceId: string, note: string, selection: string[], sheetId: string | null) => Promise<void>
  lastCreatedPlannedId: string | null   // node enters inline name-edit on mount
  createPlanned: (workspaceId: string, sheetId: string, n: Partial<PlannedNode>) => Promise<PlannedNode | null>
  updatePlanned: (workspaceId: string, n: PlannedNode) => Promise<void>
  setPlannedApproval: (workspaceId: string, id: string, decision: 'approved' | 'rejected') => Promise<void>
  previewPlannedPosition: (id: string, x: number, y: number) => void
  updatePlannedLayout: (workspaceId: string, id: string, x: number, y: number, parentSystemId: string | null, width?: number, height?: number, scale?: number) => void
  previewLayoutsBatch: (workspaceId: string, sheetId: string, layouts: SheetLayoutMutation[]) => void
  updateLayoutsBatch: (
    workspaceId: string,
    sheetId: string,
    layouts: SheetLayoutMutation[],
    rollbackLayouts?: SheetLayout[],
  ) => Promise<void>
  deletePlanned: (workspaceId: string, id: string) => Promise<void>
  createPlannedEdge: (workspaceId: string, sheetId: string, e: Partial<PlannedEdge>) => Promise<void>
  createFloatingNote: (workspaceId: string, sheetId: string, body: string, x: number, y: number) => Promise<void>
}

function activeLayerProjection(activeSheetId: string | null, layersById: Record<string, SheetLayerData>) {
  const active = activeSheetId ? layersById[activeSheetId] : null
  return {
    elements: active?.elements ?? [],
    annotations: active?.annotations ?? [],
    planned: active?.planned ?? [],
    plannedEdges: active?.plannedEdges ?? [],
    layouts: active?.layouts ?? [],
  }
}

function commitSheetLayer(state: SheetState, sheetId: string, layer: SheetLayerData): Partial<SheetState> {
  const layersById = { ...state.layersById, [sheetId]: layer }
  return {
    layersById,
    ...(state.activeSheetId === sheetId ? activeLayerProjection(state.activeSheetId, layersById) : {}),
  }
}

export const useSheetStore = create<SheetState>((set, get) => ({
  workspaceId: null,
  sheets: [],
  activeSheetId: null,
  visibleSheetIds: [],
  layersById: {},
  elements: [],
  annotations: [],
  planned: [],
  plannedEdges: [],
  layouts: [],
  messages: [],

  fetchSheets: async (workspaceId) => {
    const request = ++fetchSheetsRequest
    try {
      const res = await fetch(`${API}/api/sheets?workspace=${encodeURIComponent(workspaceId)}`)
      if (!res.ok || request !== fetchSheetsRequest) return
      const sheets = (await res.json()) ?? []
      if (request !== fetchSheetsRequest) return
      set(s => s.workspaceId === workspaceId
        ? { sheets }
        : {
            workspaceId, sheets, activeSheetId: null, visibleSheetIds: [], layersById: {},
            elements: [], annotations: [], planned: [], plannedEdges: [], layouts: [],
          })
    } catch (err) {
      console.error('[sheets] fetch failed:', err)
    }
  },

  openSheet: async (workspaceId, sheetId) => {
    const request = ++openSheetRequest
    if (sheetId === null) {
      set({ workspaceId, activeSheetId: null, visibleSheetIds: [], elements: [], annotations: [], planned: [], plannedEdges: [], layouts: [] })
      return
    }
    try {
      const current = get()
      const data = (current.workspaceId === workspaceId ? current.layersById[sheetId] : null)
        ?? await fetchSheetLayer(workspaceId, sheetId)
      if (!data || request !== openSheetRequest) return
      set(s => {
        const sameWorkspace = s.workspaceId === workspaceId
        const visibleSheetIds = sameWorkspace ? s.visibleSheetIds : []
        const layersById = sameWorkspace ? s.layersById : {}
        const nextLayers = { ...layersById, [sheetId]: data }
        return {
          workspaceId, activeSheetId: sheetId,
          visibleSheetIds: [...visibleSheetIds.filter(id => id !== sheetId), sheetId],
          layersById: nextLayers,
          ...activeLayerProjection(sheetId, nextLayers),
        }
      })
    } catch (err) {
      console.error('[sheets] open failed:', err)
    }
  },

  toggleSheetVisibility: async (workspaceId, sheetId) => {
    const state = get()
    const sameWorkspace = state.workspaceId === workspaceId
    if (sameWorkspace && state.visibleSheetIds.includes(sheetId)) {
      const visibleSheetIds = state.visibleSheetIds.filter(id => id !== sheetId)
      const activeSheetId = state.activeSheetId === sheetId
        ? (visibleSheetIds.at(-1) ?? null)
        : state.activeSheetId
      set({
        visibleSheetIds,
        activeSheetId,
        ...activeLayerProjection(activeSheetId, state.layersById),
      })
      return
    }
    try {
      const data = (sameWorkspace ? state.layersById[sheetId] : null) ?? await fetchSheetLayer(workspaceId, sheetId)
      if (!data) return
      if (get().workspaceId !== workspaceId) return
      set(s => {
        const currentWorkspace = s.workspaceId === workspaceId
        const visibleSheetIds = currentWorkspace ? s.visibleSheetIds : []
        const layersById = currentWorkspace ? s.layersById : {}
        return {
          workspaceId,
          visibleSheetIds: [...visibleSheetIds.filter(id => id !== sheetId), sheetId],
          layersById: { ...layersById, [sheetId]: data },
          ...(!currentWorkspace ? {
            activeSheetId: null, elements: [], annotations: [], planned: [], plannedEdges: [], layouts: [],
          } : {}),
        }
      })
    } catch (err) {
      console.error('[sheets] visibility toggle failed:', err)
    }
  },

  lastCreatedPlannedId: null,

  createPlanned: async (workspaceId, sheetId, n) => {
    const kind = n.kind ?? 'class'
    const res = await fetch(`${API}/api/sheets/${encodeURIComponent(sheetId)}/planned`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId, createdBy: 'user', ...n, kind,
        members: n.members ?? [],
        metadata: n.metadata ?? defaultPlannedMetadata(kind),
      }),
    })
    if (!res.ok) throw new Error(await res.text())
    const created = withValidScale(await res.json() as PlannedNode)
    set(s => {
      const layer = s.layersById[sheetId]
      if (!layer) return s
      const planned = [...layer.planned.filter(p => p.id !== created.id), created]
      return {
        ...commitSheetLayer(s, sheetId, { ...layer, planned }),
        lastCreatedPlannedId: created.id,
      }
    })
    return created
  },

  updatePlanned: async (workspaceId, n) => {
    const previous = get().layersById[n.sheetId]?.planned.find(planned => planned.id === n.id)
    // optimistic — the node is the editor, edits must feel instant
    set(s => {
      const layer = s.layersById[n.sheetId]
      if (!layer) return s
      const planned = layer.planned.map(p => p.id === n.id ? n : p)
      return commitSheetLayer(s, n.sheetId, { ...layer, planned })
    })
    try {
      const res = await fetch(`${API}/api/planned/${encodeURIComponent(n.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...n, workspaceId,
          members: plannedMembers(n),
          metadata: plannedMetadata(n),
        }),
      })
      if (!res.ok) throw new Error(await res.text())
    } catch (error) {
      let reverted = false
      if (previous) set(s => {
        const layer = s.layersById[n.sheetId]
        if (!layer) return s
        const current = layer.planned.find(planned => planned.id === n.id)
        if (current !== n) return s
        const planned = layer.planned.map(item => item.id === n.id ? previous : item)
        reverted = true
        return commitSheetLayer(s, n.sheetId, { ...layer, planned })
      })
      console.error('[sheets] planned node update failed:', error)
      // Watching your own typing silently undo itself reads as the app
      // corrupting your work. Say who reverted it and why.
      if (reverted) {
        raiseFailure(
          `planned-update:${n.id}`,
          `Could not save changes to "${previous?.name ?? 'this element'}"`,
          `${error instanceof Error ? error.message : String(error)} — your edit was rolled back.`,
        )
      }
    }
  },

  setPlannedApproval: async (workspaceId, id, decision) => {
    const planned = Object.values(get().layersById)
      .flatMap(layer => layer.planned)
      .find(node => node.id === id)
    if (!planned) throw new Error('Planned node is not loaded')
    const res = await fetch(`${API}/api/planned/${encodeURIComponent(id)}/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, decision }),
    })
    if (!res.ok) throw new Error(await res.text())
    const updated = withValidScale(await res.json() as PlannedNode)
    set(s => {
      const layer = s.layersById[updated.sheetId]
      if (!layer) return s
      const nodes = layer.planned.map(node => node.id === updated.id ? updated : node)
      return commitSheetLayer(s, updated.sheetId, { ...layer, planned: nodes })
    })
  },

  createFloatingNote: async (workspaceId, sheetId, body, x, y) => {
    await fetch(`${API}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, sheetId, body, author: 'user', positionX: x, positionY: y }),
    }).catch(() => {})
  },

  previewPlannedPosition: (id, x, y) => {
    set(s => {
      const activeId = s.activeSheetId
      const layer = activeId ? s.layersById[activeId] : null
      if (!activeId || !layer) return s
      const planned = layer.planned.map(p => p.id === id ? { ...p, positionX: x, positionY: y } : p)
      return commitSheetLayer(s, activeId, { ...layer, planned })
    })
  },

  updatePlannedLayout: (workspaceId, id, x, y, parentSystemId, width, height, scale) => {
    const sheetId = get().activeSheetId
    if (!sheetId || !get().layersById[sheetId]?.planned.some(p => p.id === id)) {
      console.warn('[SheetDragTrace:store] planned layout rejected locally', { sheetId, id, x, y, parentSystemId })
      return
    }
    set(s => {
      const layer = s.layersById[sheetId]
      if (!layer) return s
      const planned = layer.planned.map(p => p.id === id ? {
        ...p, positionX: x, positionY: y, parentSystemId,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(scale !== undefined ? { scale } : {}),
      } : p)
      return commitSheetLayer(s, sheetId, { ...layer, planned })
    })
    void (async () => {
      try {
        const res = await fetch(`${API}/api/planned/${encodeURIComponent(id)}/layout`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId, x, y, parentSystemId, width, height, scale }),
        })
        if (!res.ok) throw new Error(await res.text())
        console.info('[SheetDragTrace:api] planned layout accepted', { sheetId, id, x, y, parentSystemId, width, height })
      } catch (err) {
        console.error('[sheets] planned layout update failed:', err)
        const restored = await fetchSheetLayer(workspaceId, sheetId).catch(() => null)
        if (restored) set(s => commitSheetLayer(s, sheetId, restored))
      }
    })()
  },

  previewLayoutsBatch: (workspaceId, sheetId, layouts) => {
    set(state => {
      const layer = state.layersById[sheetId]
      if (!layer) return state
      const byId = new Map(layer.layouts.map(layout => [layout.nodeId, layout]))
      const updatedAt = Date.now()
      for (const layout of layouts) {
        byId.set(layout.nodeId, { ...layout, sheetId, workspaceId, updatedAt })
      }
      return commitSheetLayer(state, sheetId, { ...layer, layouts: [...byId.values()] })
    })
  },

  updateLayoutsBatch: async (workspaceId, sheetId, layouts, rollbackLayouts) => {
    if (layouts.length === 0) return
    const sequence = ++sheetLayoutWriteSequence
    const previous = new Map<string, SheetLayout | undefined>()
    const requestedIds = new Set(layouts.map(layout => layout.nodeId))
    const layerBefore = get().layersById[sheetId]
    const rollbackById = rollbackLayouts
      ? new Map(rollbackLayouts.map(layout => [layout.nodeId, layout]))
      : null
    for (const layout of layouts) {
      previous.set(
        layout.nodeId,
        rollbackById
          ? rollbackById.get(layout.nodeId)
          : layerBefore?.layouts.find(item => item.nodeId === layout.nodeId),
      )
      pendingSheetLayoutWrites.set(`${sheetId}:${layout.nodeId}`, sequence)
    }
    set(state => {
      const layer = state.layersById[sheetId]
      if (!layer) return state
      const byId = new Map(layer.layouts.map(layout => [layout.nodeId, layout]))
      const updatedAt = Date.now()
      for (const layout of layouts) {
        byId.set(layout.nodeId, { ...layout, sheetId, workspaceId, updatedAt })
      }
      return commitSheetLayer(state, sheetId, { ...layer, layouts: [...byId.values()] })
    })
    const predecessor = sheetLayoutSaveQueues.get(sheetId) ?? Promise.resolve()
    let releaseQueue!: () => void
    const gate = new Promise<void>(resolve => { releaseQueue = resolve })
    const queueTail = predecessor.catch(() => {}).then(() => gate)
    sheetLayoutSaveQueues.set(sheetId, queueTail)
    await predecessor.catch(() => {})
    try {
      const response = await fetch(`${API}/api/sheets/${encodeURIComponent(sheetId)}/layouts/batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, layouts }),
      })
      if (!response.ok) throw new Error(await response.text())
      const result = await response.json() as { revision: number; layouts: SheetLayout[] }
      set(state => {
        const layer = state.layersById[sheetId]
        if (!layer) return state
        const byId = new Map(layer.layouts.map(layout => [layout.nodeId, layout]))
        for (const layout of result.layouts ?? []) {
          if (pendingSheetLayoutWrites.get(`${sheetId}:${layout.nodeId}`) === sequence) {
            byId.set(layout.nodeId, layout)
          }
        }
        const sheet = result.revision > layer.sheet.revision
          ? { ...layer.sheet, revision: result.revision }
          : layer.sheet
        return commitSheetLayer(state, sheetId, { ...layer, sheet, layouts: [...byId.values()] })
      })
      for (const id of requestedIds) {
        const key = `${sheetId}:${id}`
        if (pendingSheetLayoutWrites.get(key) === sequence) pendingSheetLayoutWrites.delete(key)
      }
    } catch (error) {
      console.error('[sheets] batch layout update failed:', error)
      set(state => {
        const layer = state.layersById[sheetId]
        if (!layer) return state
        const byId = new Map(layer.layouts.map(layout => [layout.nodeId, layout]))
        for (const id of requestedIds) {
          const key = `${sheetId}:${id}`
          if (pendingSheetLayoutWrites.get(key) !== sequence) continue
          const oldLayout = previous.get(id)
          if (oldLayout) byId.set(id, oldLayout)
          else byId.delete(id)
          pendingSheetLayoutWrites.delete(key)
        }
        return commitSheetLayer(state, sheetId, { ...layer, layouts: [...byId.values()] })
      })
      throw error
    } finally {
      releaseQueue()
      if (sheetLayoutSaveQueues.get(sheetId) === queueTail) {
        sheetLayoutSaveQueues.delete(sheetId)
      }
    }
  },

  deletePlanned: async (workspaceId, id) => {
    const response = await fetch(
      `${API}/api/planned/${encodeURIComponent(id)}?workspace=${encodeURIComponent(workspaceId)}`,
      { method: 'DELETE' },
    )
    if (!response.ok) throw new Error(await response.text())
    set(s => {
      const sheetId = s.activeSheetId
      const layer = sheetId ? s.layersById[sheetId] : null
      if (!sheetId || !layer) return s
      return commitSheetLayer(s, sheetId, {
        ...layer,
        planned: layer.planned.filter(p => p.id !== id),
        layouts: layer.layouts.filter(layout => layout.nodeId !== `planned:${id}`),
      })
    })
  },

  createPlannedEdge: async (workspaceId, sheetId, e) => {
    const res = await fetch(`${API}/api/sheets/${encodeURIComponent(sheetId)}/planned-edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, ...e }),
    })
    if (!res.ok) throw new Error(await res.text())
    const created = await res.json() as PlannedEdge
    set(s => {
      const layer = s.layersById[sheetId]
      if (!layer) return s
      const plannedEdges = [...layer.plannedEdges.filter(x => x.id !== created.id), created]
      return commitSheetLayer(s, sheetId, { ...layer, plannedEdges })
    })
  },

  // Throws on refusal. The server rejects duplicate names, and "a sheet named X
  // already exists" is the only useful thing to say at that moment — swallowing
  // it into a null would leave the caller guessing that archd was down.
  createSheet: async (workspaceId, name, purpose, fileIds) => {
    const res = await fetch(`${API}/api/sheets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId, name,
        purpose: purpose || null,
        createdBy: 'user',
        elements: fileIds.map((id, i) => ({
          fileId: id,
          // starting grid so a fresh sheet isn't a stack at 0,0
          x: 40 + (i % 5) * 220, y: 40 + Math.floor(i / 5) * 120,
        })),
      }),
    })
    if (!res.ok) throw new Error(await refusalReason(res, 'Create failed'))
    const sheet = await res.json() as Sheet
    await get().fetchSheets(workspaceId)
    return sheet
  },

  deleteSheet: async (workspaceId, sheetId) => {
    try {
      const res = await fetch(`${API}/api/sheets/${encodeURIComponent(sheetId)}?workspace=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await res.text())
      set(s => {
        const layersById = { ...s.layersById }
        delete layersById[sheetId]
        const visibleSheetIds = s.visibleSheetIds.filter(id => id !== sheetId)
        const activeSheetId = s.activeSheetId === sheetId ? (visibleSheetIds.at(-1) ?? null) : s.activeSheetId
        return {
          visibleSheetIds, layersById, activeSheetId,
          ...activeLayerProjection(activeSheetId, layersById),
        }
      })
      await get().fetchSheets(workspaceId)
    } catch (err) {
      console.error('[sheets] delete failed:', err)
    }
  },

  previewElementPosition: (elementId, x, y) => {
    const sheetId = get().activeSheetId
    if (!sheetId || !get().layersById[sheetId]?.elements.some(e => e.id === elementId)) return
    set(s => {
      const layer = s.layersById[sheetId]
      if (!layer) return s
      const elements = layer.elements.map(e => e.id === elementId ? { ...e, positionX: x, positionY: y } : e)
      return commitSheetLayer(s, sheetId, { ...layer, elements })
    })
  },

  updateElementLayout: (workspaceId, elementId, x, y, parentSystemId, width, height, scale) => {
    const sheetId = get().activeSheetId
    if (!sheetId || !get().layersById[sheetId]?.elements.some(e => e.id === elementId)) {
      console.warn('[SheetDragTrace:store] element layout rejected locally', { sheetId, elementId, x, y, parentSystemId })
      return
    }
    set(s => {
      const layer = s.layersById[sheetId]
      if (!layer) return s
      const elements = layer.elements.map(e => e.id === elementId ? {
        ...e, positionX: x, positionY: y, parentSystemId,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(scale !== undefined ? { scale } : {}),
      } : e)
      return commitSheetLayer(s, sheetId, { ...layer, elements })
    })
    void (async () => {
      try {
        const res = await fetch(`${API}/api/sheets/${encodeURIComponent(sheetId)}/elements/${encodeURIComponent(elementId)}/layout`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId, x, y, parentSystemId, width, height, scale }),
        })
        if (!res.ok) throw new Error(await res.text())
        console.info('[SheetDragTrace:api] element layout accepted', { sheetId, elementId, x, y, parentSystemId, width, height })
      } catch (err) {
        console.error('[sheets] element layout update failed:', err)
        const restored = await fetchSheetLayer(workspaceId, sheetId).catch(() => null)
        if (restored) set(s => commitSheetLayer(s, sheetId, restored))
      }
    })()
  },

  updateElementMetadata: async (workspaceId, elementId, metadata) => {
    const sheetId = get().activeSheetId
    if (!sheetId) return
    const previous = get().layersById[sheetId]?.elements.find(element => element.id === elementId)?.designMetadata
    set(s => {
      const layer = s.layersById[sheetId]
      if (!layer) return s
      const elements = layer.elements.map(element => element.id === elementId ? { ...element, designMetadata: metadata } : element)
      return commitSheetLayer(s, sheetId, { ...layer, elements })
    })
    try {
      const res = await fetch(`${API}/api/sheets/${encodeURIComponent(sheetId)}/elements/${encodeURIComponent(elementId)}/metadata`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, metadata }),
      })
      if (!res.ok) throw new Error(await res.text())
    } catch (error) {
      set(s => {
        const layer = s.layersById[sheetId]
        if (!layer) return s
        const elements = layer.elements.map(element => element.id === elementId
          ? { ...element, designMetadata: previous }
          : element)
        return commitSheetLayer(s, sheetId, { ...layer, elements })
      })
      throw error
    }
  },

  removeElement: async (workspaceId, sheetId, elementId) => {
    const response = await fetch(
      `${API}/api/sheets/${encodeURIComponent(sheetId)}/elements/${encodeURIComponent(elementId)}?workspace=${encodeURIComponent(workspaceId)}`,
      { method: 'DELETE' },
    )
    if (!response.ok) throw new Error(await response.text())
    set(s => {
      const layer = s.layersById[sheetId]
      if (!layer) return s
      const removed = layer.elements.find(e => e.id === elementId)
      const nodeId = removed?.systemId ?? removed?.fileId ?? removed?.infraId
      const elements = layer.elements.filter(e => e.id !== elementId)
      return commitSheetLayer(s, sheetId, {
        ...layer, elements,
        layouts: nodeId ? layer.layouts.filter(layout => layout.nodeId !== nodeId) : layer.layouts,
      })
    })
  },

  sendToAgent: async (workspaceId, note, selection, sheetId) => {
    const res = await fetch(`${API}/api/canvas/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId, note, sheetId,
        selection: JSON.stringify(selection),
      }),
    })
    if (!res.ok) throw new Error(await res.text())
    const message = await res.json() as CanvasMessage
    set(state => ({
      messages: state.messages.some(item => item.id === message.id)
        ? state.messages.map(item => item.id === message.id ? message : item)
        : [...state.messages, message],
    }))
  },
}))

// handleSheetPatch routes sheet/annotation/canvas WebSocket patches into the
// sheet store. Called from graphStore's patch pipeline (one-way dependency).
export function handleSheetPatch(patch: { type: string; payload: unknown }): void {
  const s = useSheetStore.getState()
  switch (patch.type) {
    case 'sheet:upserted': {
      const sheet = patch.payload as Sheet
      useSheetStore.setState(st => ({
        sheets: st.sheets.some(x => x.id === sheet.id)
          ? st.sheets.map(x => x.id === sheet.id && sheet.revision >= x.revision ? sheet : x)
          : [...st.sheets, sheet],
        layersById: st.layersById[sheet.id] && sheet.revision >= st.layersById[sheet.id].sheet.revision
          ? { ...st.layersById, [sheet.id]: { ...st.layersById[sheet.id], sheet } }
          : st.layersById,
      }))
      break
    }
    case 'sheet:deleted': {
      const { id } = patch.payload as { id: string }
      useSheetStore.setState(st => {
        const layersById = { ...st.layersById }
        delete layersById[id]
        const visibleSheetIds = st.visibleSheetIds.filter(x => x !== id)
        const activeSheetId = st.activeSheetId === id ? (visibleSheetIds.at(-1) ?? null) : st.activeSheetId
        return {
          sheets: st.sheets.filter(x => x.id !== id), layersById, visibleSheetIds, activeSheetId,
          ...(st.activeSheetId === id ? activeLayerProjection(activeSheetId, layersById) : {}),
        }
      })
      break
    }
    case 'sheet:elements': {
      const { sheetId, added, removed, replace } = patch.payload as {
        sheetId: string
        added?: SheetElement[]
        removed?: string[]
        replace?: boolean
      }
      if (!s.layersById[sheetId]) break
      useSheetStore.setState(st => {
        const layer = st.layersById[sheetId]
        if (!layer) return st
        const elements = replace
          ? (added ?? []).map(withValidScale)
          : [
              ...layer.elements.filter(e => !(removed ?? []).includes(e.id) && !(added ?? []).some(a => a.id === e.id)),
              ...(added ?? []).map(withValidScale),
            ]
        return commitSheetLayer(st, sheetId, { ...layer, elements })
      })
      break
    }
    case 'sheet:layouts': {
      const { sheetId, layouts, revision, replace } = patch.payload as {
        sheetId: string
        layouts?: SheetLayout[]
        revision?: number
        replace?: boolean
      }
      if (!s.layersById[sheetId]) break
      useSheetStore.setState(st => {
        const layer = st.layersById[sheetId]
        if (!layer) return st
        if (revision !== undefined && revision < layer.sheet.revision) return st
        const byId = new Map((replace
          ? layer.layouts.filter(layout => pendingSheetLayoutWrites.has(`${sheetId}:${layout.nodeId}`))
          : layer.layouts
        ).map(layout => [layout.nodeId, layout]))
        for (const layout of layouts ?? []) {
          if (!pendingSheetLayoutWrites.has(`${sheetId}:${layout.nodeId}`)) {
            byId.set(layout.nodeId, layout)
          }
        }
        const sheet = revision !== undefined && revision > layer.sheet.revision
          ? { ...layer.sheet, revision }
          : layer.sheet
        return commitSheetLayer(st, sheetId, { ...layer, sheet, layouts: [...byId.values()] })
      })
      break
    }
    case 'annotation:upserted': {
      const a = patch.payload as SheetAnnotation
      if (!a.sheetId || !s.layersById[a.sheetId]) break
      useSheetStore.setState(st => {
        const layer = st.layersById[a.sheetId!]
        const annotations = layer.annotations.some(x => x.id === a.id)
          ? layer.annotations.map(x => x.id === a.id ? a : x)
          : [...layer.annotations, a]
        return commitSheetLayer(st, a.sheetId!, { ...layer, annotations })
      })
      break
    }
    case 'annotation:deleted': {
      const { id } = patch.payload as { id: string }
      useSheetStore.setState(st => {
        const layersById = Object.fromEntries(Object.entries(st.layersById).map(([sheetId, layer]) => [
          sheetId, { ...layer, annotations: layer.annotations.filter(x => x.id !== id) },
        ]))
        return { layersById, ...activeLayerProjection(st.activeSheetId, layersById) }
      })
      break
    }
    case 'planned:upserted': {
      const p = withValidScale(patch.payload as PlannedNode)
      if (!s.layersById[p.sheetId]) break
      useSheetStore.setState(st => {
        const layer = st.layersById[p.sheetId]
        const planned = layer.planned.some(x => x.id === p.id)
          ? layer.planned.map(x => x.id === p.id ? p : x)
          : [...layer.planned, p]
        return commitSheetLayer(st, p.sheetId, { ...layer, planned })
      })
      break
    }
    case 'planned:deleted': {
      const { id } = patch.payload as { id: string }
      useSheetStore.setState(st => {
        const layersById = Object.fromEntries(Object.entries(st.layersById).map(([sheetId, layer]) => [
          sheetId, {
            ...layer,
            planned: layer.planned.filter(x => x.id !== id),
            layouts: layer.layouts.filter(layout => layout.nodeId !== `planned:${id}`),
          },
        ]))
        return { layersById, ...activeLayerProjection(st.activeSheetId, layersById) }
      })
      break
    }
    case 'planned:edge': {
      const e = patch.payload as PlannedEdge
      if (!s.layersById[e.sheetId]) break
      useSheetStore.setState(st => {
        const layer = st.layersById[e.sheetId]
        const plannedEdges = layer.plannedEdges.some(x => x.id === e.id)
          ? layer.plannedEdges.map(x => x.id === e.id ? e : x)
          : [...layer.plannedEdges, e]
        return commitSheetLayer(st, e.sheetId, { ...layer, plannedEdges })
      })
      break
    }
    case 'planned:edge-deleted': {
      const { id } = patch.payload as { id: string }
      useSheetStore.setState(st => {
        const layersById = Object.fromEntries(Object.entries(st.layersById).map(([sheetId, layer]) => [
          sheetId, { ...layer, plannedEdges: layer.plannedEdges.filter(x => x.id !== id) },
        ]))
        return { layersById, ...activeLayerProjection(st.activeSheetId, layersById) }
      })
      break
    }
    case 'canvas:message': {
      const m = patch.payload as CanvasMessage
      useSheetStore.setState(st => ({
        messages: st.messages.some(x => x.id === m.id)
          ? st.messages.map(x => x.id === m.id ? m : x)
          : [...st.messages, m],
      }))
      break
    }
  }
}
