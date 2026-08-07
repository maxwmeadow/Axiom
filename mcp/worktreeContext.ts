export interface WorktreeRow {
  id: string
  path: string
  branch: string
}

export interface WorktreeContext {
  rootId: string
  branch: string
}

function normalizePath(value: string, caseSensitive: boolean): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return caseSensitive ? normalized : normalized.toLowerCase()
}

export function findWorktreeForCwd(
  roots: WorktreeRow[],
  cwd: string,
  caseSensitive = process.platform !== 'win32',
): WorktreeContext | undefined {
  const target = normalizePath(cwd, caseSensitive)
  let best: WorktreeRow | undefined
  let bestLength = -1
  for (const root of roots) {
    const candidate = normalizePath(root.path, caseSensitive)
    const contains = target === candidate || target.startsWith(`${candidate}/`)
    if (contains && candidate.length > bestLength) {
      best = root
      bestLength = candidate.length
    }
  }
  return best ? { rootId: best.id, branch: best.branch } : undefined
}
