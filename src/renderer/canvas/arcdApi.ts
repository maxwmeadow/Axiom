import type {
  AgentAction,
  DbSystem,
  DeltaSummary,
  FloorLayout,
  ParallelAgentSnapshot,
  ParallelCommandDeckStatus,
} from '../../shared/types'

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
 * Acknowledges up to the moment the reviewed delta was computed - never "now"
 * - so changes that landed while the user was reading survive into the next
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

export async function apiGetParallelCommandDeck(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<ParallelCommandDeckStatus> {
  const params = new URLSearchParams({ workspace: workspaceId })
  const res = await fetch(`${BASE}/api/command-deck?${params}`, { signal })
  if (!res.ok) throw new Error(await res.text() || `Unable to load branch briefing (${res.status})`)
  return res.json() as Promise<ParallelCommandDeckStatus>
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
  // Throw rather than log: a caller that rolls back an optimistic move cannot
  // do so if the failure never reaches it. Swallowing this made a rejected
  // assignment look exactly like a successful one that then vanished.
  if (!res.ok) {
    const detail = await res.text()
    console.error('[arcdApi] assignFile failed', { fileId, systemId, status: res.status, detail })
    throw new Error(`assignFile failed (${res.status}): ${detail}`)
  }
}

/**
 * Forget authored geometry for these nodes.
 *
 * The counterpart to saving a layout: a node with no row is one the renderer is
 * free to place, which is what returning a file to the unsorted bin means.
 */
export async function apiRemoveFloorLayouts(
  workspaceId: string,
  remove: Array<{ nodeId: string; nodeType: 'system' | 'file' | 'infra' }>,
): Promise<void> {
  if (remove.length === 0) return
  const res = await fetch(`${BASE}/api/layout/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, layouts: [], remove }),
  })
  if (!res.ok) throw new Error(`removeFloorLayouts failed (${res.status}): ${await res.text()}`)
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

// ─── Investigation Capture ──────────────────────────────────────────────────

export interface InvestigationMeta {
  id: string
  name: string
  commit: string
  branch: string
  createdAt: number
  durationMs: number
  eventCount: number
  /** 'saved' | 'recording' | 'interrupted' */
  status: string
  /** 'agent' | 'human' | 'auto' - who began the recording. */
  origin: string
}

export interface ActiveInvestigation {
  id: string
  name: string
  commit: string
  branch: string
  createdAt: number
  /** How much is already captured, so a window joining late shows the truth. */
  eventCount: number
  status: string
  origin: string
}

export async function apiListInvestigations(workspaceId: string): Promise<{
  investigations: InvestigationMeta[]
  recording: ActiveInvestigation | null
}> {
  const res = await fetch(`${BASE}/api/investigation/list?workspace=${encodeURIComponent(workspaceId)}`)
  if (!res.ok) throw new Error(await res.text() || `Unable to load captures (${res.status})`)
  const body = await res.json() as { investigations?: InvestigationMeta[]; recording?: ActiveInvestigation | null }
  return { investigations: body.investigations ?? [], recording: body.recording ?? null }
}

export async function apiGetInvestigation(workspaceId: string, id: string): Promise<unknown> {
  const res = await fetch(`${BASE}/api/investigation/${encodeURIComponent(id)}?workspace=${encodeURIComponent(workspaceId)}`)
  if (!res.ok) throw new Error(await res.text() || `Unable to open capture (${res.status})`)
  return res.json()
}

export async function apiStartInvestigation(workspaceId: string, name: string): Promise<{ id: string; name: string; commit: string; note?: string }> {
  const res = await fetch(`${BASE}/api/investigation/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // Pressing record is the human path; an agent asking gets 'agent', and a
    // recording Axiom starts by noticing gets 'auto'.
    body: JSON.stringify({ workspaceId, name, origin: 'human' }),
  })
  if (!res.ok) throw new Error(await res.text() || 'Unable to start recording')
  return res.json()
}

export async function apiStopInvestigation(workspaceId: string): Promise<{ id: string; eventCount: number }> {
  const res = await fetch(`${BASE}/api/investigation/stop`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  })
  if (!res.ok) throw new Error(await res.text() || 'Unable to stop recording')
  return res.json()
}

export async function apiDeleteInvestigation(workspaceId: string, id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/investigation/${encodeURIComponent(id)}?workspace=${encodeURIComponent(workspaceId)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(await res.text() || 'Unable to delete capture')
}
