import React, { useCallback, useEffect, useState } from 'react'
import type { ProjectConfig } from '../../shared/types'

interface DirEntry {
  name: string
  isDirectory: boolean
  path: string
}

interface TreeNode {
  name: string
  path: string
  isDirectory: boolean
  children?: TreeNode[]
  excluded: boolean
  expanded: boolean
}

// Directories that are almost never useful to index
const COMMON_NOISE = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.env',
  'coverage', '.nyc_output',
  'vendor', 'target',
  '.idea', '.vscode', '.vs',
  // Unity-specific
  'Library', 'Temp', 'Logs', 'UserSettings', 'obj',
  // Other generated dirs
  'Packages/cache', '.gradle', '.mvn', 'bin', '.cache',
])

function shouldAutoExclude(name: string): boolean {
  return COMMON_NOISE.has(name) || name.startsWith('.')
}

function makeTreeNode(entry: DirEntry): TreeNode {
  return {
    name: entry.name,
    path: entry.path,
    isDirectory: entry.isDirectory,
    excluded: shouldAutoExclude(entry.name),
    expanded: false,
    children: entry.isDirectory ? undefined : undefined,
  }
}

interface ProjectSetupScreenProps {
  baseConfig: ProjectConfig
  onConfirm: (config: ProjectConfig) => void
  onCancel: () => void
}

export function ProjectSetupScreen({ baseConfig, onConfirm, onCancel }: ProjectSetupScreenProps) {
  const { rootPath, name: projectName } = baseConfig
  const [tree, setTree] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(true)

  // Load top-level entries on mount
  useEffect(() => {
    if (!window.axiom) {
      setLoading(false)
      return
    }
    window.axiom.listDir(rootPath).then(entries => {
      const nodes = entries
        .filter(e => e.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(makeTreeNode)
      setTree(nodes)
      setLoading(false)
    })
  }, [rootPath])

  const toggleExclude = useCallback((nodePath: string) => {
    setTree(prev => toggleNode(prev, nodePath, 'excluded'))
  }, [])

  const toggleExpand = useCallback(async (nodePath: string) => {
    // Load children if not yet loaded
    const node = findNode(tree, nodePath)
    if (!node) return
    if (node.isDirectory && !node.children && window.axiom) {
      const entries = await window.axiom.listDir(nodePath)
      const children = entries
        .filter(e => e.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(makeTreeNode)
      setTree(prev => setChildren(prev, nodePath, children))
    }
    setTree(prev => toggleNode(prev, nodePath, 'expanded'))
  }, [tree])

  const excludedPaths = collectExcluded(tree, rootPath)
  const includedCount = countIncluded(tree)

  const handleConfirm = () => {
    // Merge excluded paths into the base config provided by main process.
    // ID was already computed by main.ts (Node.js), so we don't need Buffer here.
    onConfirm({ ...baseConfig, ignoredPaths: excludedPaths, openedAt: Date.now() })
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%',
      background: 'var(--bg-base)',
    }}>
      {/* Header */}
      <div style={{
        padding: '20px 24px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <button
          onClick={onCancel}
          style={{ color: 'var(--text-dim)', fontSize: 18, padding: '0 8px 0 0', lineHeight: 1 }}
        >←</button>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
            Configure Project
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, fontFamily: 'monospace' }}>
            {rootPath}
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Tree */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: '12px 0',
          borderRight: '1px solid var(--border)',
        }}>
          <div style={{
            padding: '4px 20px 8px',
            fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: '0.06em',
          }}>
            DIRECTORIES — uncheck to exclude from indexing
          </div>
          {loading ? (
            <div style={{ padding: '20px', color: 'var(--text-dim)', fontSize: 13 }}>Loading…</div>
          ) : tree.length === 0 ? (
            <div style={{ padding: '20px', color: 'var(--text-dim)', fontSize: 13 }}>No subdirectories found.</div>
          ) : (
            tree.map(node => (
              <TreeRow
                key={node.path}
                node={node}
                depth={0}
                onToggleExclude={toggleExclude}
                onToggleExpand={toggleExpand}
              />
            ))
          )}
        </div>

        {/* Sidebar summary */}
        <div style={{
          width: 220, padding: 20, flexShrink: 0,
          display: 'flex', flexDirection: 'column', gap: 16,
        }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 8, letterSpacing: '0.06em' }}>
              SUMMARY
            </div>
            <SummaryRow label="Project" value={projectName} />
            <SummaryRow label="Included dirs" value={String(includedCount)} />
            <SummaryRow label="Excluded dirs" value={String(excludedPaths.length)} />
          </div>

          {excludedPaths.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 6, letterSpacing: '0.06em' }}>
                EXCLUDED
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {excludedPaths.slice(0, 12).map(p => (
                  <div key={p} style={{
                    fontSize: 10, color: 'var(--text-dim)', fontFamily: 'monospace',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    padding: '2px 6px',
                    background: 'var(--bg-raised)',
                    borderRadius: 0,
                  }}>
                    {p.replace(rootPath, '').replace(/^[/\\]/, '')}
                  </div>
                ))}
                {excludedPaths.length > 12 && (
                  <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>+{excludedPaths.length - 12} more</div>
                )}
              </div>
            </div>
          )}

          <div style={{ flex: 1 }} />

          <button
            onClick={handleConfirm}
            style={{
              padding: '10px 16px',
              background: 'var(--accent)',
              borderRadius: 0,
              fontSize: 13, fontWeight: 600, color: '#fff',
              textAlign: 'center',
            }}
          >
            Start Indexing
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── TreeRow ────────────────────────────────────────────────────────────────

interface TreeRowProps {
  node: TreeNode
  depth: number
  onToggleExclude: (path: string) => void
  onToggleExpand: (path: string) => void
}

function TreeRow({ node, depth, onToggleExclude, onToggleExpand }: TreeRowProps) {
  const hasChildren = node.isDirectory
  const isExpanded = node.expanded
  const isExcluded = node.excluded

  return (
    <div>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: `4px 20px 4px ${20 + depth * 16}px`,
          opacity: isExcluded ? 0.4 : 1,
          transition: 'opacity 0.1s',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-raised)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        {/* Expand toggle */}
        <button
          onClick={() => hasChildren && onToggleExpand(node.path)}
          style={{
            width: 14, fontSize: 9, color: 'var(--text-dim)', flexShrink: 0,
            visibility: hasChildren ? 'visible' : 'hidden',
          }}
        >
          {isExpanded ? '▼' : '▶'}
        </button>

        {/* Include/exclude checkbox */}
        <input
          type="checkbox"
          checked={!isExcluded}
          onChange={() => onToggleExclude(node.path)}
          style={{ flexShrink: 0, cursor: 'pointer', width: 13, height: 13 }}
        />

        {/* Folder icon + name */}
        <span style={{ fontSize: 12, color: 'var(--text-dim)', flexShrink: 0 }}>
          {isExpanded ? '📂' : '📁'}
        </span>
        <span style={{
          fontSize: 13, color: isExcluded ? 'var(--text-dim)' : 'var(--text-primary)',
          fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {node.name}
        </span>
        {isExcluded && (
          <span style={{ fontSize: 10, color: 'var(--text-dim)', flexShrink: 0 }}>excluded</span>
        )}
      </div>

      {/* Children */}
      {isExpanded && node.children && (
        <div>
          {node.children.map(child => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              onToggleExclude={onToggleExclude}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{label}</span>
      <span style={{ fontSize: 11, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{value}</span>
    </div>
  )
}

// ─── Tree helpers ────────────────────────────────────────────────────────────

function findNode(nodes: TreeNode[], targetPath: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.path === targetPath) return n
    if (n.children) {
      const found = findNode(n.children, targetPath)
      if (found) return found
    }
  }
  return undefined
}

function toggleNode(nodes: TreeNode[], targetPath: string, field: 'excluded' | 'expanded'): TreeNode[] {
  return nodes.map(n => {
    if (n.path === targetPath) return { ...n, [field]: !n[field] }
    if (n.children) return { ...n, children: toggleNode(n.children, targetPath, field) }
    return n
  })
}

function setChildren(nodes: TreeNode[], targetPath: string, children: TreeNode[]): TreeNode[] {
  return nodes.map(n => {
    if (n.path === targetPath) return { ...n, children }
    if (n.children) return { ...n, children: setChildren(n.children, targetPath, children) }
    return n
  })
}

function collectExcluded(nodes: TreeNode[], _rootPath: string): string[] {
  const result: string[] = []
  const visit = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (n.excluded) {
        // Use glob pattern so chokidar ignores all contents too
        result.push(`${n.path}/**`)
      } else if (n.children) {
        visit(n.children)
      }
    }
  }
  visit(nodes)
  return result
}

function countIncluded(nodes: TreeNode[]): number {
  let count = 0
  const visit = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (!n.excluded) {
        count++
        if (n.children) visit(n.children)
      }
    }
  }
  visit(nodes)
  return count
}
