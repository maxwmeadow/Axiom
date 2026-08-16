import chokidar from 'chokidar'
import path from 'path'
import fs from 'fs'
import { EventEmitter } from 'events'
import { parseFile, buildModuleNodes, LANG_MAP, initParser } from './parser'
import { GraphStore } from './graph-store'
import type { GraphPatch, IndexingProgress } from '../src/shared/types'

const SUPPORTED_EXTENSIONS = new Set(Object.keys(LANG_MAP))
const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/__pycache__/**',
  '**/*.pyc',
  '**/coverage/**',
  '**/.venv/**',
  '**/venv/**',
  '**/target/**',    // Rust
  '**/vendor/**',
  '**/obj/**',       // C# build output
  '**/bin/**',       // C# / Java build output
  '**/.vs/**',       // Visual Studio
  '**/Packages/**',  // Unity packages (auto-managed)
  '**/Library/**',   // Unity library cache
  '**/Temp/**',      // Unity temp
  '**/*.meta',       // Unity meta files (text but not code)
]

// Chunk size for async batch processing - keeps the event loop responsive
const PARSE_CHUNK_SIZE = 30

export interface WatcherEvents {
  patch: (patch: GraphPatch) => void
  progress: (progress: IndexingProgress) => void
  ready: (stats: { totalFiles: number; totalNodes: number }) => void
}

export class FsWatcher extends EventEmitter {
  private watcher?: ReturnType<typeof chokidar.watch>
  private rootPath: string
  private store: GraphStore
  private ignoredPaths: string[]
  private debounceTimers = new Map<string, NodeJS.Timeout>()
  private indexedFiles = new Set<string>()
  private isIndexing = false

  constructor(rootPath: string, store: GraphStore, ignoredPaths: string[] = []) {
    super()
    this.rootPath = rootPath
    this.store = store
    this.ignoredPaths = [...DEFAULT_IGNORE, ...ignoredPaths]
  }

  async start(): Promise<void> {
    this.isIndexing = true
    try {
      await initParser()
    } catch (err) {
      console.error('[FsWatcher] Failed to initialize tree-sitter parser, falling back to regex: ', err)
    }
    await this.initialIndex()
    this.isIndexing = false
    this.watchForChanges()
  }

  stop(): void {
    this.watcher?.close()
  }

  // ─── Initial full index (async chunked) ──────────────────────────────

  private async initialIndex(): Promise<void> {
    const allFiles = this.collectFiles(this.rootPath)
    const total = allFiles.length

    this.store.clear()

    // Stage 1: parse all files in async chunks (keeps event loop alive for IPC)
    let processed = 0
    for (let i = 0; i < allFiles.length; i += PARSE_CHUNK_SIZE) {
      const chunk = allFiles.slice(i, i + PARSE_CHUNK_SIZE)

      for (const filePath of chunk) {
        const result = parseFile(filePath, this.rootPath)
        if (result) {
          this.store.upsertNodes(result.nodes)
          this.store.upsertDependencies(result.dependencies)
          this.indexedFiles.add(filePath)
        }
        processed++
        this.emit('progress', {
          filesProcessed: processed,
          filesTotal: total,
          currentFile: path.relative(this.rootPath, filePath),
        } satisfies IndexingProgress)
      }

      // Yield to event loop between chunks so IPC messages can flow
      await new Promise<void>(resolve => setImmediate(resolve))
    }

    // Stage 2: build module/directory hierarchy (synchronous - fast SQL batch)
    const { nodes: modNodes, dependencies: modDeps, fileParentMap } = buildModuleNodes(this.rootPath, allFiles)
    this.store.upsertNodes(modNodes)
    this.store.upsertDependencies(modDeps)

    // Stage 3: wire file nodes to their parent module via parentId
    this.store.updateFileParents(fileParentMap)

    // Stage 4: update child counts
    this.store.updateChildCounts()

    const stats = this.store.getStats()
    this.emit('ready', { totalFiles: processed, totalNodes: stats.nodeCount })
  }

  // ─── Incremental file watching ────────────────────────────────────────

  private watchForChanges(): void {
    this.watcher = chokidar.watch(this.rootPath, {
      ignored: this.ignoredPaths,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    })

    this.watcher
      .on('add', (fp) => this.scheduleReindex(fp))
      .on('change', (fp) => this.scheduleReindex(fp))
      .on('unlink', (fp) => this.handleDelete(fp))
  }

  private scheduleReindex(filePath: string): void {
    if (!this.isSupportedFile(filePath)) return
    const existing = this.debounceTimers.get(filePath)
    if (existing) clearTimeout(existing)
    this.debounceTimers.set(filePath, setTimeout(() => {
      this.debounceTimers.delete(filePath)
      this.reindexFile(filePath)
    }, 150))
  }

  private reindexFile(filePath: string): void {
    // Remove old nodes/edges for this file
    const removedNodeIds = this.store.getAllNodes()
      .filter(n => n.filePath === filePath)
      .map(n => n.id)

    this.store.deleteNodesByFilePath(filePath)
    this.store.deleteDependenciesByFilePath(filePath)

    // Re-parse
    const result = parseFile(filePath, this.rootPath)
    if (!result) return

    // Wire parentId: find which module owns this file
    const dir = path.dirname(filePath)
    const { hash: computeHash } = require('./parser')
    const modId = `mod_${computeHash(dir)}`
    result.nodes.forEach(n => {
      if (n.type === 'file') n.parentId = modId
    })

    this.store.upsertNodes(result.nodes)
    this.store.upsertDependencies(result.dependencies)
    this.store.updateChildCounts()

    const patch: GraphPatch = {
      addedNodes: result.nodes,
      removedNodeIds,
      updatedNodes: [],
      addedDependencies: result.dependencies,
      removedDependencyIds: [],
    }
    this.emit('patch', patch)
    this.store.logEvent('file:changed', { filePath })
  }

  private handleDelete(filePath: string): void {
    const removedNodeIds = this.store.getAllNodes()
      .filter(n => n.filePath === filePath)
      .map(n => n.id)

    this.store.deleteDependenciesByFilePath(filePath)
    this.store.deleteNodesByFilePath(filePath)
    this.store.updateChildCounts()
    this.indexedFiles.delete(filePath)

    const patch: GraphPatch = {
      addedNodes: [],
      removedNodeIds,
      updatedNodes: [],
      addedDependencies: [],
      removedDependencyIds: [],
    }
    this.emit('patch', patch)
    this.store.logEvent('file:deleted', { filePath })
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private collectFiles(dir: string): string[] {
    const results: string[] = []
    const ignored = this.ignoredPaths.map(p => p.replace(/\*/g, ''))
    const visit = (d: string) => {
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const full = path.join(d, entry.name)
        if (ignored.some(ig => full.includes(ig.replace(/\//g, path.sep)))) continue
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory()) visit(full)
        else if (entry.isFile() && this.isSupportedFile(full)) results.push(full)
      }
    }
    visit(dir)
    return results
  }

  private isSupportedFile(filePath: string): boolean {
    return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  }
}
