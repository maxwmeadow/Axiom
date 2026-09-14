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
  // Windows and macOS are both case-insensitive by default - NTFS always, and
  // APFS/HFS+ unless deliberately formatted otherwise. Only Linux is case-
  // sensitive, so only Linux may treat two spellings as two worktrees.
  caseSensitive = process.platform !== 'win32' && process.platform !== 'darwin',
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
