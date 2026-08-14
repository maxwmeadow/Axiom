import { randomUUID } from 'crypto'
import fs from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import type { ProjectConfig } from '../src/shared/types'

export function sameProjectRoot(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

export function findProjectByRoot(
  projects: readonly ProjectConfig[],
  rootPath: string,
): ProjectConfig | undefined {
  return projects.find(project => sameProjectRoot(project.rootPath, rootPath))
}

/** A project id names one lifetime, not one filesystem path forever. */
export function createProjectId(): string {
  return randomUUID()
}

function validatedProjectDataDir(dataDir: string, projectId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(projectId) || projectId === '.' || projectId === '..') {
    throw new Error('Invalid project id.')
  }
  const base = resolve(dataDir)
  const target = resolve(base, projectId)
  const rel = relative(base, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || dirname(target) !== base) {
    throw new Error('Project data path escapes Axiom\'s data directory.')
  }
  return target
}

function clearActiveProjectPointer(dataDir: string, projectId: string): void {
  const activePath = join(dataDir, 'active_project.json')
  if (!fs.existsSync(activePath)) return
  try {
    const active = JSON.parse(fs.readFileSync(activePath, 'utf8')) as { workspaceId?: string }
    if (active.workspaceId === projectId) fs.rmSync(activePath, { force: true })
  } catch {
    // A malformed pointer is not safe to retain after deleting its project.
    fs.rmSync(activePath, { force: true })
  }
}

export interface RemoveProjectDataOptions {
  projectId: string
  dataDir: string
  apiPort: number
  request?: typeof fetch
}

/**
 * Permanently removes one project lifetime. The daemon is authoritative while
 * running because it owns SQLite and watcher locks; a local fallback covers a
 * stopped daemon and older daemon builds. Success is reported only after the
 * directory is verified absent.
 */
export async function removeProjectData({
  projectId,
  dataDir,
  apiPort,
  request = fetch,
}: RemoveProjectDataOptions): Promise<void> {
  const projectDataDir = validatedProjectDataDir(dataDir, projectId)
  let daemonUnavailable = false
  try {
    const response = await request(
      `http://127.0.0.1:${apiPort}/api/workspace/${encodeURIComponent(projectId)}`,
      { method: 'DELETE' },
    )
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Axiom could not delete the project data (${response.status})${detail ? `: ${detail}` : '.'}`)
    }
  } catch (error) {
    // HTTP responses are authoritative failures. Connection failures mean the
    // daemon is down, so there can be no daemon-owned SQLite lock to release.
    if (error instanceof Error && error.message.startsWith('Axiom could not delete')) throw error
    daemonUnavailable = true
  }

  // Current archd deletes the directory itself. This also supports users whose
  // running daemon predates that contract and only closed its connection.
  if (daemonUnavailable || fs.existsSync(projectDataDir)) {
    fs.rmSync(projectDataDir, { recursive: true, force: true })
  }
  if (fs.existsSync(projectDataDir)) {
    throw new Error('Axiom could not verify that the project data was deleted.')
  }
  clearActiveProjectPointer(dataDir, projectId)
}
