import type { AgentAction, DbSystem, DeltaSummary, FloorLayout, ParallelAgentSnapshot } from '../../shared/types'

const BASE = 'http://127.0.0.1:7744'

/**
 * Fetching a delta never acknowledges it. The watermark only moves on
 * apiAckDelta, so closing Axiom mid-review leaves the delta waiting.
 */
export async function apiGetDelta(workspaceId: string, signal?: AbortSignal): Promise<DeltaSummary> {
  return apiGetDeltaForRoot(workspaceId, undefined, undefined, signal)
}

export async function apiGetDeltaForRoot(
  workspaceId: string,
  rootId?: string,
  branch?: string,
  signal?: AbortSignal,
): Promise<DeltaSummary> {
  const params = new URLSearchParams({ workspace: workspaceId })
  if (rootId) params.set('root', rootId)
  if (branch) params.set('branch', branch)
  const res = await fetch(`${BASE}/api/delta?${params}`, { signal })
  if (!res.ok) throw new Error(await res.text() || `Unable to load delta (${res.status})`)
  return res.json() as Promise<DeltaSummary>
}

/**
 * Acknowledges up to the moment the reviewed delta was computed — never "now"
 * — so changes that landed while the user was reading survive into the next
 * delta instead of being silently swallowed.
 */
export async function apiAckDelta(workspaceId: string, until: number): Promise<void> {
  return apiAckDeltaForRoot(workspaceId, until)
}

export async function apiAckDeltaForRoot(
  workspaceId: string,
  until: number,
  rootId?: string,
  branch?: string,
): Promise<void> {
  const res = await fetch(`${BASE}/api/delta/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, rootId, branch, until }),
  })
  if (!res.ok) throw new Error(await res.text() || `Unable to acknowledge delta (${res.status})`)
}

export async function apiGetBranchCollisions(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<ParallelAgentSnapshot> {
  const params = new URLSearchParams({ workspace: workspaceId })
  const res = await fetch(`${BASE}/api/collisions?${params}`, { signal })
  if (!res.ok) throw new Error(await res.text() || `Unable to load branch collisions (${res.status})`)
  return res.json() as Promise<ParallelAgentSnapshot>
}

export interface FileSource {
  fileId: string
  relPath: string
  language: string
  lineCount: number
  content: string
}

export async function apiGetFileSource(fileId: string, workspaceId: string, signal?: AbortSignal): Promise<FileSource> {
  const res = await fetch(`${BASE}/api/files/${encodeURIComponent(fileId)}/source?workspace=${encodeURIComponent(workspaceId)}`, { signal })
  if (!res.ok) throw new Error(await res.text() || `Unable to load source (${res.status})`)
  return res.json() as Promise<FileSource>
}

export async function apiSaveFloorLayouts(workspaceId: string, layouts: Omit<FloorLayout, 'workspaceId' | 'updatedAt'>[]): Promise<FloorLayout[]> {
  const res = await fetch(`${BASE}/api/layout/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, layouts }),
  })
  if (!res.ok) throw new Error(await res.text())
  const result = await res.json() as { revision: number; layouts: FloorLayout[] }
  return result.layouts
}

export async function apiAssignFile(fileId: string, systemId: string | null, workspaceId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/files/${fileId}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemId, workspaceId }),
  })
  if (!res.ok) console.error('[arcdApi] assignFile failed', await res.text())
}

export async function apiUpdateFileSize(fileId: string, w: number, h: number, workspaceId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/files/${fileId}/size`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ w, h, workspaceId }),
  })
  if (!res.ok) console.error('[arcdApi] updateFileSize failed', await res.text())
}

export async function apiUpdateSystem(system: DbSystem): Promise<void> {
  const res = await fetch(`${BASE}/api/systems/${system.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(system),
  })
  if (!res.ok) throw new Error(await res.text() || `Unable to update system (${res.status})`)
}

export async function apiSaveNodePosition(
  nodeId: string,
  x: number,
  y: number,
  workspaceId: string,
  nodeType: 'system' | 'file',
): Promise<void> {
  const path = nodeType === 'system'
    ? `${BASE}/api/systems/${nodeId}/position?workspace=${encodeURIComponent(workspaceId)}`
    : `${BASE}/api/files/${nodeId}/position`

  const body = nodeType === 'system'
    ? JSON.stringify({ x, y })
    : JSON.stringify({ x, y, workspaceId })

  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  if (!res.ok) console.error('[arcdApi] saveNodePosition failed', await res.text())
}

/**
 * The recent agent action log. Durable in archd; the renderer keeps a window
 * of it for the visual log and reloads on project open.
 */
export async function apiGetAgentActions(workspaceId: string, limit = 200): Promise<AgentAction[]> {
  const res = await fetch(
    `${BASE}/api/agent/actions?workspace=${encodeURIComponent(workspaceId)}&limit=${limit}`,
  )
  if (!res.ok) throw new Error(await res.text() || `Unable to load agent log (${res.status})`)
  return res.json() as Promise<AgentAction[]>
}
