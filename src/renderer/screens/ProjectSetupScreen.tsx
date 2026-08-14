import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProjectConfig } from '../../shared/types'
import { completeSourceBoundaries } from '../../shared/projectLifecycle'
import { classifyProjectFile, type ProjectFileKind } from '../../shared/fileKinds'
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
  kind: ProjectFileKind
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
  const kind = classifyProjectFile(entry.name, entry.isDirectory)
  return {
    name: entry.name,
    path: entry.path,
    isDirectory: entry.isDirectory,
    kind,
    excluded: shouldAutoExclude(entry.name) || kind === 'unsupported',
    expanded: false,
  }
}

function foldersFirst(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
    const leftExcluded = shouldAutoExclude(left.name)
    const rightExcluded = shouldAutoExclude(right.name)
    if (leftExcluded !== rightExcluded) return leftExcluded ? 1 : -1
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  })
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
      return () => { active = false }
    }

    void window.axiom.listDir(rootPath)
      .then(entries => {
        if (active) setTree(foldersFirst(entries).map(makeTreeNode))
      })
      .catch(() => {
        if (active) setLoadError('Axiom could not read this project directory.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => { active = false }
  }, [rootPath])

  const toggleExclude = useCallback((nodePath: string) => {
    setTree(previous => toggleNode(previous, nodePath, 'excluded'))
  }, [])

  const toggleExpand = useCallback(async (nodePath: string) => {
    const node = findNode(tree, nodePath)
    if (!node?.isDirectory) return

    if (!node.children && window.axiom) {
      try {
        const entries = await window.axiom.listDir(nodePath)
        setTree(previous => setChildren(previous, nodePath, foldersFirst(entries).map(makeTreeNode)))
      } catch {
        setLoadError(`Axiom could not read ${node.name}.`)
        return
      }
    }

    setTree(previous => toggleNode(previous, nodePath, 'expanded'))
  }, [tree])

  const excludedPaths = useMemo(() => collectExcluded(tree), [tree])
  const included = useMemo(() => countIncludedKinds(tree), [tree])

  const handleConfirm = () => {
    onConfirm({
      ...completeSourceBoundaries(baseConfig, excludedPaths),
      openedAt: Date.now(),
    })
  }

  return (
    <main className="axiom-onboarding axiom-project-setup">
      <WorkbenchTitleBar context="Project Setup" status="PRE-INDEX" />

      <div className="axiom-source-setup">
        <header className="axiom-source-setup__header">
          <button className="axiom-source-setup__back" onClick={onCancel} aria-label="Back to projects">
            <span aria-hidden="true">←</span>
            Projects
          </button>
          <div className="axiom-source-setup__intro">
            <div>
              <p className="axiom-source-setup__eyebrow">Choose what Axiom reads</p>
              <h1>Set up {projectName}</h1>
              <p className="axiom-source-setup__description">
                Source files are included by default. Common generated and dependency folders are skipped automatically;
                documentation stays searchable outside the canvas, and unsupported assets are never indexed.
              </p>
            </div>
            <code className="axiom-source-setup__path" title={rootPath}>{rootPath}</code>
          </div>
        </header>

        <section className="axiom-source-browser" aria-labelledby="source-browser-title">
          <header className="axiom-source-browser__header">
            <div>
              <p>Project contents</p>
              <h2 id="source-browser-title">Files and folders</h2>
            </div>
            <div className="axiom-source-browser__legend" aria-label="Selection key">
              <span><i className="axiom-source-browser__legend-check" aria-hidden="true" /> Source → canvas</span>
              <span>Documents → library</span>
              <span>Unsupported → skipped</span>
            </div>
          </header>

          {loadError && <div className="axiom-source-setup__notice" role="alert">{loadError}</div>}

          <div className="axiom-setup-tree axiom-source-browser__tree" role="tree" aria-label="Project files and folders">
            {loading ? (
              <div className="axiom-setup-tree__state" role="status">
                <span className="axiom-setup-tree__busy" aria-hidden="true" />
                Reading project contents…
              </div>
            ) : tree.length === 0 ? (
              <div className="axiom-setup-tree__state">This project is empty.</div>
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

          <footer className="axiom-source-browser__footer">
            <div className="axiom-source-browser__summary" aria-live="polite">
              <strong>
                {included.files} source {included.files === 1 ? 'file' : 'files'} and {included.documents} {included.documents === 1 ? 'document' : 'documents'} selected
              </strong>
              <span>
                {excludedPaths.length === 0 ? 'Nothing excluded' : `${excludedPaths.length} ${excludedPaths.length === 1 ? 'item' : 'items'} excluded`}
                {included.unsupported > 0 ? ` · ${included.unsupported} unsupported skipped` : ''}
              </span>
            </div>
            <button
              className="axiom-source-setup__submit"
              onClick={handleConfirm}
              disabled={loading || Boolean(loadError && tree.length === 0)}
            >
              <span>
                <strong>Index this project</strong>
                <small>You can change this later</small>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          </footer>
        </section>
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
  const kindLabel = node.kind === 'source'
    ? 'Source'
    : node.kind === 'document'
      ? 'Document'
      : node.kind === 'unsupported'
        ? 'Unsupported'
        : 'Folder'

  return (
    <div
      className="axiom-setup-tree__branch"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={node.isDirectory ? node.expanded : undefined}
      data-kind={node.kind}
    >
      <div className={`axiom-setup-tree__row ${depthClass}${node.excluded ? ' axiom-setup-tree__row--excluded' : ''}`}>
        {node.isDirectory ? (
          <button
            className="axiom-setup-tree__expand"
            onClick={() => void onToggleExpand(node.path)}
            aria-label={`${node.expanded ? 'Collapse' : 'Expand'} ${node.name}`}
          >
            <span aria-hidden="true">›</span>
          </button>
        ) : (
          <span className="axiom-setup-tree__expand-spacer" aria-hidden="true" />
        )}

        <label className="axiom-setup-tree__check">
          <input
            type="checkbox"
            checked={!node.excluded}
            onChange={() => onToggleExclude(node.path)}
            aria-label={`Include ${node.name}`}
            disabled={node.kind === 'unsupported'}
          />
          <span aria-hidden="true" />
        </label>

        <span
          className={node.isDirectory
            ? `axiom-setup-tree__folder${node.expanded ? ' axiom-setup-tree__folder--open' : ''}`
            : 'axiom-setup-tree__file'}
          aria-hidden="true"
        />
        <span className="axiom-setup-tree__name" title={node.path}>{node.name}</span>
        <span className="axiom-setup-tree__kind">{kindLabel}</span>
        <span className="axiom-setup-tree__state-label">
          {node.kind === 'unsupported' ? 'Skipped' : node.kind === 'document' ? 'Documents' : node.excluded ? 'Excluded' : 'Included'}
        </span>
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
      // Unsupported files are rejected by Axiom's global file policy. They are
      // not project-specific ignore choices and must not bloat ignoredPaths.
      if (node.kind === 'unsupported') continue
      if (node.excluded) {
        result.push(node.isDirectory ? `${node.path}/**` : node.path)
      } else if (node.children) {
        visit(node.children)
      }
    }
  }
  visit(nodes)
  return result
}

function countIncludedKinds(nodes: TreeNode[]): { folders: number; files: number; documents: number; unsupported: number } {
  const result = { folders: 0, files: 0, documents: 0, unsupported: 0 }
  const visit = (branch: TreeNode[]) => {
    for (const node of branch) {
      if (node.kind === 'unsupported') {
        result.unsupported += 1
        continue
      }
      if (node.excluded) continue
      if (node.kind === 'folder') result.folders += 1
      else if (node.kind === 'document') result.documents += 1
      else if (node.kind === 'source') result.files += 1
      if (node.children) visit(node.children)
    }
  }
  visit(nodes)
  return result
}
