export interface WorktreeRow {
  id: string
  path: string
  branch: string
}

export interface WorktreeContext {
  rootId: string
  branch: string
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function findWorktreeForCwd(
  roots: WorktreeRow[],
  cwd: string,
): WorktreeContext | undefined {
  const target = normalizePath(cwd)
  let best: WorktreeRow | undefined
  let bestLength = -1
  for (const root of roots) {
    const candidate = normalizePath(root.path)
    const contains = target === candidate || target.startsWith(`${candidate}/`)
    if (contains && candidate.length > bestLength) {
      best = root
      bestLength = candidate.length
    }
  }
  return best ? { rootId: best.id, branch: best.branch } : undefined
}
