import type { DbSystem } from '../../shared/types'

const BASE = 'http://127.0.0.1:7744'

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
