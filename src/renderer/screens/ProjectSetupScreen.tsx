import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProjectConfig } from '../../shared/types'
import { completeSourceBoundaries } from '../../shared/projectLifecycle'
import { WorkbenchTitleBar } from '../components/ui/WorkbenchTitleBar'

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

const COMMON_NOISE = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.env',
  'coverage', '.nyc_output',
  'vendor', 'target',
  '.idea', '.vscode', '.vs',
  'Library', 'Temp', 'Logs', 'UserSettings', 'obj',
  '.gradle', '.mvn', 'bin', '.cache',
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
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError(null)

    if (!window.axiom) {
      setLoading(false)
      return () => {
        active = false
      }
    }

    void window.axiom.listDir(rootPath)
      .then(entries => {
        if (!active) return
        setTree(
          entries
            .filter(entry => entry.isDirectory)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(makeTreeNode)
        )
      })
      .catch(() => {
        if (active) setLoadError('Axiom could not read this project directory.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [rootPath])

  const toggleExclude = useCallback((nodePath: string) => {
    setTree(previous => toggleNode(previous, nodePath, 'excluded'))
  }, [])

  const toggleExpand = useCallback(async (nodePath: string) => {
    const node = findNode(tree, nodePath)
    if (!node) return

    if (node.isDirectory && !node.children && window.axiom) {
      try {
        const entries = await window.axiom.listDir(nodePath)
        const children = entries
          .filter(entry => entry.isDirectory)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(makeTreeNode)
        setTree(previous => setChildren(previous, nodePath, children))
      } catch {
        setLoadError(`Axiom could not read ${node.name}.`)
        return
      }
    }

    setTree(previous => toggleNode(previous, nodePath, 'expanded'))
  }, [tree])

  const excludedPaths = useMemo(() => collectExcluded(tree), [tree])
  const includedCount = useMemo(() => countIncluded(tree), [tree])

  const handleConfirm = () => {
    onConfirm({
      ...completeSourceBoundaries(baseConfig, excludedPaths),
      openedAt: Date.now(),
    })
  }

  return (
    <main className="axiom-onboarding axiom-project-setup">
      <WorkbenchTitleBar context="Project Setup" status="PRE-INDEX" />

      <div className="axiom-onboarding__board">
        <header className="axiom-onboarding__heading">
          <button className="axiom-onboarding__back" onClick={onCancel} aria-label="Back to project navigator">
            <span aria-hidden="true">←</span>
            Project Navigator
          </button>
          <div className="axiom-onboarding__step">STEP 01 / INDEX SCOPE</div>
          <h1>Choose source boundaries</h1>
          <p>
            Select the directories that belong in the architectural model. Generated output and common dependency
            folders are excluded automatically.
          </p>
          <code className="axiom-onboarding__path" title={rootPath}>{rootPath}</code>
        </header>

        <div className="axiom-setup__workspace">
          <section className="axiom-setup__tree-panel" aria-labelledby="directory-tree-title">
            <header>
              <div>
                <span>PROJECT DIRECTORY</span>
                <h2 id="directory-tree-title">{projectName}</h2>
              </div>
              <small>CHECKED DIRECTORIES WILL BE INDEXED</small>
            </header>

            {loadError && (
              <div className="axiom-setup__notice axiom-setup__notice--error" role="alert">
                {loadError}
              </div>
            )}

            <div className="axiom-setup-tree" role="tree" aria-label="Project directories">
              {loading ? (
                <div className="axiom-setup-tree__state" role="status">
                  <span className="axiom-setup-tree__busy" aria-hidden="true" />
                  Reading directory structure…
                </div>
              ) : tree.length === 0 ? (
                <div className="axiom-setup-tree__state">No subdirectories were found.</div>
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
          </section>

          <aside className="axiom-setup__summary" aria-label="Index summary">
            <div className="axiom-setup__summary-heading">
              <span>INDEX PLAN</span>
              <strong>{loading ? 'SCANNING' : 'READY'}</strong>
            </div>

            <dl className="axiom-setup__metrics">
              <SummaryRow label="Project" value={projectName} />
              <SummaryRow label="Included directories" value={String(includedCount)} />
              <SummaryRow label="Excluded directories" value={String(excludedPaths.length)} />
            </dl>

            {excludedPaths.length > 0 && (
              <div className="axiom-setup__excluded">
                <h3>EXCLUDED PATHS</h3>
                <ul>
                  {excludedPaths.slice(0, 12).map(path => (
                    <li key={path} title={path}>{relativeIgnoredPath(path, rootPath)}</li>
                  ))}
                </ul>
                {excludedPaths.length > 12 && <small>+{excludedPaths.length - 12} additional paths</small>}
              </div>
            )}

            <div className="axiom-setup__summary-note">
              <span aria-hidden="true">i</span>
              <p>You can change ignore rules later by reopening project setup.</p>
            </div>

            <button
              className="axiom-onboarding__primary"
              onClick={handleConfirm}
              disabled={loading || Boolean(loadError && tree.length === 0)}
            >
              <span>
                <strong>Start Indexing</strong>
                <small>Build the live architecture baseline</small>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          </aside>
        </div>
      </div>
    </main>
  )
}

interface TreeRowProps {
  node: TreeNode
  depth: number
  onToggleExclude: (path: string) => void
  onToggleExpand: (path: string) => void | Promise<void>
}

function TreeRow({ node, depth, onToggleExclude, onToggleExpand }: TreeRowProps) {
  const depthClass = `axiom-setup-tree__row--depth-${Math.min(depth, 8)}`

  return (
    <div
      className="axiom-setup-tree__branch"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={node.isDirectory ? node.expanded : undefined}
    >
      <div className={`axiom-setup-tree__row ${depthClass}${node.excluded ? ' axiom-setup-tree__row--excluded' : ''}`}>
        <button
          className="axiom-setup-tree__expand"
          onClick={() => void onToggleExpand(node.path)}
          aria-label={`${node.expanded ? 'Collapse' : 'Expand'} ${node.name}`}
          disabled={!node.isDirectory}
        >
          <span aria-hidden="true">›</span>
        </button>

        <label className="axiom-setup-tree__check">
          <input
            type="checkbox"
            checked={!node.excluded}
            onChange={() => onToggleExclude(node.path)}
            aria-label={`Include ${node.name}`}
          />
          <span aria-hidden="true" />
        </label>

        <span className={node.expanded ? 'axiom-setup-tree__folder axiom-setup-tree__folder--open' : 'axiom-setup-tree__folder'} aria-hidden="true" />
        <span className="axiom-setup-tree__name" title={node.path}>{node.name}</span>
        <span className="axiom-setup-tree__state-label">{node.excluded ? 'EXCLUDED' : 'INDEX'}</span>
      </div>

      {node.expanded && node.children && (
        <div role="group">
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
    <div>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  )
}

function relativeIgnoredPath(path: string, rootPath: string): string {
  return path
    .replace(/[/\\]\*\*$/, '')
    .replace(rootPath, '')
    .replace(/^[/\\]/, '')
}

function findNode(nodes: TreeNode[], targetPath: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === targetPath) return node
    if (node.children) {
      const found = findNode(node.children, targetPath)
      if (found) return found
    }
  }
  return undefined
}

function toggleNode(nodes: TreeNode[], targetPath: string, field: 'excluded' | 'expanded'): TreeNode[] {
  return nodes.map(node => {
    if (node.path === targetPath) return { ...node, [field]: !node[field] }
    if (node.children) return { ...node, children: toggleNode(node.children, targetPath, field) }
    return node
  })
}

function setChildren(nodes: TreeNode[], targetPath: string, children: TreeNode[]): TreeNode[] {
  return nodes.map(node => {
    if (node.path === targetPath) return { ...node, children }
    if (node.children) return { ...node, children: setChildren(node.children, targetPath, children) }
    return node
  })
}

function collectExcluded(nodes: TreeNode[]): string[] {
  const result: string[] = []
  const visit = (branch: TreeNode[]) => {
    for (const node of branch) {
      if (node.excluded) {
        result.push(`${node.path}/**`)
      } else if (node.children) {
        visit(node.children)
      }
    }
  }
  visit(nodes)
  return result
}

function countIncluded(nodes: TreeNode[]): number {
  let count = 0
  const visit = (branch: TreeNode[]) => {
    for (const node of branch) {
      if (!node.excluded) {
        count += 1
        if (node.children) visit(node.children)
      }
    }
  }
  visit(nodes)
  return count
}
