import type { DbSystem, FloorLayout } from '../../shared/types'

const BASE = 'http://127.0.0.1:7744'

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
  if (!res.ok) console.error('[arcdApi] updateSystem failed', await res.text())
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
