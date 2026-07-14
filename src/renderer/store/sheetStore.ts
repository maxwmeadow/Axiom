// Sheets — curated diagrams over the live model (UML_UX_PLAN.md U1) plus the
// canvas→agent message channel (U-C). The Floor (live master canvas) is
// activeSheetId === null.
import { create } from 'zustand'

const API = 'http://127.0.0.1:7743'

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
  tombstoneAck: number
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
  status: 'queued' | 'delivered' | 'answered'
  deliveredTo: string | null
  answerAnnotationId: string | null
  createdAt: number
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
  kind: 'system' | 'class' | 'file'
  name: string
  declaredPath: string
  members: PlannedMember[] | string   // server sends json; normalize on read
  status: 'planned' | 'partial' | 'realized' | 'flattened'
  realizedFileId: string | null
  notes: string
  shape: '' | 'box' | 'folder' | 'cylinder' | 'hexagon'
  color: string
  positionX: number
  positionY: number
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

export function plannedMembers(n: PlannedNode): PlannedMember[] {
  if (Array.isArray(n.members)) return n.members
  try { return JSON.parse(n.members || '[]') } catch { return [] }
}

interface SheetState {
  sheets: Sheet[]
  activeSheetId: string | null           // null = The Floor (base layer only)
  elements: SheetElement[]               // active sheet's members
  annotations: SheetAnnotation[]         // active sheet's notes
  planned: PlannedNode[]                 // active sheet's planned elements
  plannedEdges: PlannedEdge[]
  messages: CanvasMessage[]              // recent canvas→agent messages (chips)

  fetchSheets: (workspaceId: string) => Promise<void>
  openSheet: (workspaceId: string, sheetId: string | null) => Promise<void>
  createSheet: (workspaceId: string, name: string, purpose: string, fileIds: string[]) => Promise<Sheet | null>
  deleteSheet: (workspaceId: string, sheetId: string) => Promise<void>
  moveElement: (workspaceId: string, elementId: string, x: number, y: number) => void
  removeElement: (workspaceId: string, sheetId: string, elementId: string) => Promise<void>
  sendToAgent: (workspaceId: string, note: string, selection: string[], sheetId: string | null) => Promise<void>
  lastCreatedPlannedId: string | null   // node enters inline name-edit on mount
  createPlanned: (workspaceId: string, sheetId: string, n: Partial<PlannedNode>) => Promise<void>
  updatePlanned: (workspaceId: string, n: PlannedNode) => Promise<void>
  movePlanned: (workspaceId: string, id: string, x: number, y: number) => void
  deletePlanned: (workspaceId: string, id: string) => Promise<void>
  createPlannedEdge: (workspaceId: string, sheetId: string, e: Partial<PlannedEdge>) => Promise<void>
  createFloatingNote: (workspaceId: string, sheetId: string, body: string, x: number, y: number) => Promise<void>
}

export const useSheetStore = create<SheetState>((set, get) => ({
  sheets: [],
  activeSheetId: null,
  elements: [],
  annotations: [],
  planned: [],
  plannedEdges: [],
  messages: [],

  fetchSheets: async (workspaceId) => {
    try {
      const res = await fetch(`${API}/api/sheets?workspace=${encodeURIComponent(workspaceId)}`)
      if (res.ok) set({ sheets: (await res.json()) ?? [] })
    } catch (err) {
      console.error('[sheets] fetch failed:', err)
    }
  },

  openSheet: async (workspaceId, sheetId) => {
    if (sheetId === null) {
      set({ activeSheetId: null, elements: [], annotations: [], planned: [], plannedEdges: [] })
      return
    }
    try {
      const res = await fetch(`${API}/api/sheets/${encodeURIComponent(sheetId)}?workspace=${encodeURIComponent(workspaceId)}`)
      if (!res.ok) return
      const data = await res.json() as {
        sheet: Sheet; elements: SheetElement[]; annotations: SheetAnnotation[]
        planned: PlannedNode[]; plannedEdges: PlannedEdge[]
      }
      set({
        activeSheetId: sheetId,
        elements: data.elements ?? [],
        annotations: data.annotations ?? [],
        planned: data.planned ?? [],
        plannedEdges: data.plannedEdges ?? [],
      })
    } catch (err) {
      console.error('[sheets] open failed:', err)
    }
  },

  lastCreatedPlannedId: null,

  createPlanned: async (workspaceId, sheetId, n) => {
    const res = await fetch(`${API}/api/sheets/${encodeURIComponent(sheetId)}/planned`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, createdBy: 'user', ...n, members: n.members ?? [] }),
    })
    if (!res.ok) throw new Error(await res.text())
    const created = await res.json() as PlannedNode
    set(s => ({
      planned: [...s.planned.filter(p => p.id !== created.id), created],
      lastCreatedPlannedId: created.id,
    }))
  },

  updatePlanned: async (workspaceId, n) => {
    // optimistic — the node is the editor, edits must feel instant
    set(s => ({ planned: s.planned.map(p => p.id === n.id ? n : p) }))
    await fetch(`${API}/api/planned/${encodeURIComponent(n.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...n, workspaceId, members: plannedMembers(n) }),
    }).catch(() => {})
  },

  createFloatingNote: async (workspaceId, sheetId, body, x, y) => {
    await fetch(`${API}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, sheetId, body, author: 'user', positionX: x, positionY: y }),
    }).catch(() => {})
  },

  movePlanned: (workspaceId, id, x, y) => {
    set(s => ({ planned: s.planned.map(p => p.id === id ? { ...p, positionX: x, positionY: y } : p) }))
    void fetch(`${API}/api/planned/${encodeURIComponent(id)}/position`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, x, y }),
    }).catch(() => {})
  },

  deletePlanned: async (workspaceId, id) => {
    await fetch(`${API}/api/planned/${encodeURIComponent(id)}?workspace=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' }).catch(() => {})
    set(s => ({ planned: s.planned.filter(p => p.id !== id) }))
  },

  createPlannedEdge: async (workspaceId, sheetId, e) => {
    const res = await fetch(`${API}/api/sheets/${encodeURIComponent(sheetId)}/planned-edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, ...e }),
    })
    if (!res.ok) throw new Error(await res.text())
    const created = await res.json() as PlannedEdge
    set(s => ({ plannedEdges: [...s.plannedEdges.filter(x => x.id !== created.id), created] }))
  },

  createSheet: async (workspaceId, name, purpose, fileIds) => {
    try {
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
      if (!res.ok) throw new Error(await res.text())
      const sheet = await res.json() as Sheet
      await get().fetchSheets(workspaceId)
      return sheet
    } catch (err) {
      console.error('[sheets] create failed:', err)
      return null
    }
  },

  deleteSheet: async (workspaceId, sheetId) => {
    try {
      await fetch(`${API}/api/sheets/${encodeURIComponent(sheetId)}?workspace=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' })
      if (get().activeSheetId === sheetId) {
        set({ activeSheetId: null, elements: [], annotations: [] })
      }
      await get().fetchSheets(workspaceId)
    } catch (err) {
      console.error('[sheets] delete failed:', err)
    }
  },

  moveElement: (workspaceId, elementId, x, y) => {
    set(s => ({ elements: s.elements.map(e => e.id === elementId ? { ...e, positionX: x, positionY: y } : e) }))
    void fetch(`${API}/api/sheets/${encodeURIComponent(get().activeSheetId ?? '')}/elements/${encodeURIComponent(elementId)}/position`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, x, y }),
    }).catch(() => {})
  },

  removeElement: async (workspaceId, sheetId, elementId) => {
    await fetch(`${API}/api/sheets/${encodeURIComponent(sheetId)}/elements/${encodeURIComponent(elementId)}?workspace=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' }).catch(() => {})
    set(s => ({ elements: s.elements.filter(e => e.id !== elementId) }))
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
          ? st.sheets.map(x => x.id === sheet.id ? sheet : x)
          : [...st.sheets, sheet],
      }))
      break
    }
    case 'sheet:deleted': {
      const { id } = patch.payload as { id: string }
      useSheetStore.setState(st => ({
        sheets: st.sheets.filter(x => x.id !== id),
        ...(st.activeSheetId === id ? { activeSheetId: null, elements: [], annotations: [] } : {}),
      }))
      break
    }
    case 'sheet:elements': {
      const { sheetId, added, removed } = patch.payload as { sheetId: string; added?: SheetElement[]; removed?: string[] }
      if (s.activeSheetId !== sheetId) break
      useSheetStore.setState(st => ({
        elements: [
          ...st.elements.filter(e => !(removed ?? []).includes(e.id) && !(added ?? []).some(a => a.id === e.id)),
          ...(added ?? []),
        ],
      }))
      break
    }
    case 'annotation:upserted': {
      const a = patch.payload as SheetAnnotation
      if (a.sheetId && a.sheetId !== s.activeSheetId) break
      useSheetStore.setState(st => ({
        annotations: st.annotations.some(x => x.id === a.id)
          ? st.annotations.map(x => x.id === a.id ? a : x)
          : [...st.annotations, a],
      }))
      break
    }
    case 'annotation:deleted': {
      const { id } = patch.payload as { id: string }
      useSheetStore.setState(st => ({ annotations: st.annotations.filter(x => x.id !== id) }))
      break
    }
    case 'planned:upserted': {
      const p = patch.payload as PlannedNode
      if (p.sheetId !== s.activeSheetId) break
      useSheetStore.setState(st => ({
        planned: st.planned.some(x => x.id === p.id)
          ? st.planned.map(x => x.id === p.id ? p : x)
          : [...st.planned, p],
      }))
      break
    }
    case 'planned:deleted': {
      const { id } = patch.payload as { id: string }
      useSheetStore.setState(st => ({ planned: st.planned.filter(x => x.id !== id) }))
      break
    }
    case 'planned:edge': {
      const e = patch.payload as PlannedEdge
      if (e.sheetId !== s.activeSheetId) break
      useSheetStore.setState(st => ({
        plannedEdges: st.plannedEdges.some(x => x.id === e.id)
          ? st.plannedEdges.map(x => x.id === e.id ? e : x)
          : [...st.plannedEdges, e],
      }))
      break
    }
    case 'planned:edge-deleted': {
      const { id } = patch.payload as { id: string }
      useSheetStore.setState(st => ({ plannedEdges: st.plannedEdges.filter(x => x.id !== id) }))
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
