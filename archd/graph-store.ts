import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import type { AsmNode, AsmDependency, GraphPatch, MutationIntent } from '../src/shared/types'

export class GraphStore {
  private db: Database.Database

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true })
    const dbPath = path.join(dataDir, 'asm.sqlite')
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.init()
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        layer TEXT NOT NULL,
        label TEXT NOT NULL,
        file_path TEXT,
        language TEXT,
        line_count INTEGER,
        child_count INTEGER DEFAULT 0,
        parent_id TEXT,
        pos_x REAL DEFAULT 0,
        pos_y REAL DEFAULT 0,
        metadata TEXT DEFAULT '{}',
        churn_score REAL DEFAULT 0,
        semantic_depth INTEGER DEFAULT 0,
        agent_authored INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT (unixepoch('now') * 1000)
      );

      CREATE TABLE IF NOT EXISTS dependencies (
        id TEXT PRIMARY KEY,
        src TEXT NOT NULL,
        dst TEXT NOT NULL,
        type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        active INTEGER DEFAULT 1,
        label TEXT,
        agent_authored INTEGER DEFAULT 0,
        FOREIGN KEY(src) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY(dst) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_layer ON nodes(layer);
      CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_depth ON nodes(semantic_depth);
      CREATE INDEX IF NOT EXISTS idx_dependencies_src ON dependencies(src);
      CREATE INDEX IF NOT EXISTS idx_dependencies_dst ON dependencies(dst);
      CREATE INDEX IF NOT EXISTS idx_dependencies_type ON dependencies(type);

      CREATE TABLE IF NOT EXISTS event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        author TEXT DEFAULT 'system',
        created_at INTEGER DEFAULT (unixepoch('now') * 1000)
      );

      CREATE TABLE IF NOT EXISTS mutation_history (
        id TEXT PRIMARY KEY,
        intent_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        semantic_hint TEXT,
        created_at INTEGER DEFAULT (unixepoch('now') * 1000)
      );
    `)

    // Migrations: add new columns to existing DBs
    this.migrate()
  }

  private migrate() {
    const columns = (this.db.prepare("PRAGMA table_info(nodes)").all() as any[]).map(r => r.name)
    if (!columns.includes('semantic_depth')) {
      this.db.exec('ALTER TABLE nodes ADD COLUMN semantic_depth INTEGER DEFAULT 0')
    }
    if (!columns.includes('agent_authored')) {
      this.db.exec('ALTER TABLE nodes ADD COLUMN agent_authored INTEGER DEFAULT 0')
    }

    const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(r => r.name)
    if (tables.includes('edges') && !tables.includes('dependencies')) {
      this.db.exec('ALTER TABLE edges RENAME TO dependencies')
    }

    const depColumns = (this.db.prepare("PRAGMA table_info(dependencies)").all() as any[]).map(r => r.name)
    if (!depColumns.includes('label')) {
      this.db.exec('ALTER TABLE dependencies ADD COLUMN label TEXT')
    }
    if (!depColumns.includes('agent_authored')) {
      this.db.exec('ALTER TABLE dependencies ADD COLUMN agent_authored INTEGER DEFAULT 0')
    }
  }

  // ─── Node Operations ───────────────────────────────────────────────────

  upsertNode(node: AsmNode): void {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, type, layer, label, file_path, language, line_count,
        child_count, parent_id, pos_x, pos_y, metadata, churn_score, semantic_depth,
        agent_authored, updated_at)
      VALUES (@id, @type, @layer, @label, @filePath, @language, @lineCount,
        @childCount, @parentId, @posX, @posY, @metadata, @churnScore, @semanticDepth,
        @agentAuthored, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        layer = excluded.layer,
        label = excluded.label,
        file_path = excluded.file_path,
        language = excluded.language,
        line_count = excluded.line_count,
        child_count = excluded.child_count,
        parent_id = excluded.parent_id,
        metadata = excluded.metadata,
        churn_score = excluded.churn_score,
        semantic_depth = excluded.semantic_depth,
        agent_authored = excluded.agent_authored,
        updated_at = excluded.updated_at
    `)
    stmt.run({
      id: node.id,
      type: node.type,
      layer: node.layer,
      label: node.label,
      filePath: node.filePath ?? null,
      language: node.language ?? null,
      lineCount: node.lineCount ?? null,
      childCount: node.childCount,
      parentId: node.parentId ?? null,
      posX: node.position.x,
      posY: node.position.y,
      metadata: JSON.stringify(node.metadata),
      churnScore: node.churnScore ?? 0,
      semanticDepth: node.semanticDepth ?? 0,
      agentAuthored: node.agentAuthored ? 1 : 0,
      updatedAt: Date.now(),
    })
  }

  upsertNodes(nodes: AsmNode[]): void {
    const tx = this.db.transaction((ns: AsmNode[]) => {
      for (const n of ns) this.upsertNode(n)
    })
    tx(nodes)
  }

  deleteNode(id: string): void {
    this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id)
  }

  deleteNodesByFilePath(filePath: string): void {
    this.db.prepare('DELETE FROM nodes WHERE file_path = ?').run(filePath)
  }

  getNode(id: string): AsmNode | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as any
    return row ? this.rowToNode(row) : null
  }

  getNodesByLayer(layer: string): AsmNode[] {
    const rows = this.db.prepare('SELECT * FROM nodes WHERE layer = ?').all(layer) as any[]
    return rows.map(this.rowToNode)
  }

  getNodesByParent(parentId: string): AsmNode[] {
    const rows = this.db.prepare('SELECT * FROM nodes WHERE parent_id = ?').all(parentId) as any[]
    return rows.map(this.rowToNode)
  }

  getNodesByDepth(depth: number): AsmNode[] {
    const rows = this.db.prepare('SELECT * FROM nodes WHERE semantic_depth = ?').all(depth) as any[]
    return rows.map(this.rowToNode)
  }

  getAllNodes(): AsmNode[] {
    const rows = this.db.prepare('SELECT * FROM nodes').all() as any[]
    return rows.map(this.rowToNode)
  }

  /** Returns all nodes except symbols (depth < 3) — for canvas performance */
  getNodesForCanvas(): AsmNode[] {
    const rows = this.db.prepare('SELECT * FROM nodes WHERE semantic_depth < 3').all() as any[]
    return rows.map(this.rowToNode)
  }

  searchNodes(query: string, limit = 20): AsmNode[] {
    const rows = this.db.prepare(
      `SELECT * FROM nodes WHERE label LIKE ? OR file_path LIKE ? LIMIT ?`
    ).all(`%${query}%`, `%${query}%`, limit) as any[]
    return rows.map(this.rowToNode)
  }

  updateNodePosition(id: string, x: number, y: number): void {
    this.db.prepare('UPDATE nodes SET pos_x = ?, pos_y = ? WHERE id = ?').run(x, y, id)
  }

  /** Set the parentId of a node (used after file→module wiring) */
  updateNodeParent(id: string, parentId: string | null): void {
    this.db.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run(parentId, id)
  }

  /** Batch-set parentId for multiple file nodes (file path → module id) */
  updateFileParents(fileParentMap: Map<string, string>): void {
    const stmt = this.db.prepare('UPDATE nodes SET parent_id = ? WHERE file_path = ?')
    const tx = this.db.transaction((entries: [string, string][]) => {
      for (const [filePath, parentId] of entries) {
        stmt.run(parentId, filePath)
      }
    })
    tx([...fileParentMap.entries()])
  }

  updateChildCounts(): void {
    this.db.exec(`
      UPDATE nodes SET child_count = (
        SELECT COUNT(*) FROM nodes c WHERE c.parent_id = nodes.id
      )
    `)
  }

  /** Create an agent-authored system node */
  createSystemNode(node: AsmNode): void {
    this.upsertNode({ ...node, agentAuthored: true })
  }

  private rowToNode(row: any): AsmNode {
    return {
      id: row.id,
      type: row.type,
      layer: row.layer,
      label: row.label,
      filePath: row.file_path ?? undefined,
      language: row.language ?? undefined,
      lineCount: row.line_count ?? undefined,
      childCount: row.child_count ?? 0,
      parentId: row.parent_id ?? undefined,
      position: { x: row.pos_x ?? 0, y: row.pos_y ?? 0 },
      metadata: JSON.parse(row.metadata ?? '{}'),
      churnScore: row.churn_score ?? 0,
      semanticDepth: row.semantic_depth ?? 0,
      agentAuthored: row.agent_authored === 1,
    }
  }

  // ─── Dependency Operations ───────────────────────────────────────────────

  upsertDependency(dependency: AsmDependency): void {
    this.db.prepare(`
      INSERT INTO dependencies (id, src, dst, type, weight, active, label, agent_authored)
      VALUES (@id, @src, @dst, @type, @weight, @active, @label, @agentAuthored)
      ON CONFLICT(id) DO UPDATE SET
        src = excluded.src,
        dst = excluded.dst,
        type = excluded.type,
        weight = excluded.weight,
        active = excluded.active,
        label = excluded.label,
        agent_authored = excluded.agent_authored
    `).run({
      id: dependency.id,
      src: dependency.src,
      dst: dependency.dst,
      type: dependency.type,
      weight: dependency.weight,
      active: dependency.active ? 1 : 0,
      label: dependency.label ?? null,
      agentAuthored: dependency.agentAuthored ? 1 : 0,
    })
  }

  upsertDependencies(dependencies: AsmDependency[]): void {
    const tx = this.db.transaction((ds: AsmDependency[]) => {
      for (const d of ds) this.upsertDependency(d)
    })
    tx(dependencies)
  }

  deleteDependency(id: string): void {
    this.db.prepare('DELETE FROM dependencies WHERE id = ?').run(id)
  }

  deleteDependenciesByNode(nodeId: string): void {
    this.db.prepare('DELETE FROM dependencies WHERE src = ? OR dst = ?').run(nodeId, nodeId)
  }

  deleteDependenciesByFilePath(filePath: string): void {
    this.db.prepare(`
      DELETE FROM dependencies WHERE src IN (SELECT id FROM nodes WHERE file_path = ?)
        OR dst IN (SELECT id FROM nodes WHERE file_path = ?)
    `).run(filePath, filePath)
  }

  getDependency(id: string): AsmDependency | null {
    const row = this.db.prepare('SELECT * FROM dependencies WHERE id = ?').get(id) as any
    return row ? this.rowToDependency(row) : null
  }

  getAllDependencies(): AsmDependency[] {
    const rows = this.db.prepare('SELECT * FROM dependencies').all() as any[]
    return rows.map(this.rowToDependency)
  }

  /** Get all non-CONTAINS dependencies (the meaningful connections) */
  getSemanticDependencies(): AsmDependency[] {
    const rows = this.db.prepare("SELECT * FROM dependencies WHERE type != 'CONTAINS'").all() as any[]
    return rows.map(this.rowToDependency)
  }

  getDependenciesForNode(nodeId: string): AsmDependency[] {
    const rows = this.db.prepare('SELECT * FROM dependencies WHERE src = ? OR dst = ?').all(nodeId, nodeId) as any[]
    return rows.map(this.rowToDependency)
  }

  getNeighbors(nodeId: string, depth: number): { nodes: AsmNode[]; dependencies: AsmDependency[] } {
    const visitedNodes = new Set<string>([nodeId])
    const visitedDeps = new Set<string>()
    let frontier = [nodeId]

    for (let d = 0; d < depth; d++) {
      const nextFrontier: string[] = []
      for (const id of frontier) {
        const deps = this.getDependenciesForNode(id)
        for (const dep of deps) {
          if (!visitedDeps.has(dep.id)) {
            visitedDeps.add(dep.id)
            const neighbor = dep.src === id ? dep.dst : dep.src
            if (!visitedNodes.has(neighbor)) {
              visitedNodes.add(neighbor)
              nextFrontier.push(neighbor)
            }
          }
        }
      }
      frontier = nextFrontier
      if (frontier.length === 0) break
    }

    const nodes = [...visitedNodes].map(id => this.getNode(id)).filter(Boolean) as AsmNode[]
    const dependencies = [...visitedDeps].map(id => this.getDependency(id)).filter(Boolean) as AsmDependency[]
    return { nodes, dependencies }
  }

  /** Get the raw file list for agent consumption */
  getRawFiles(): { filePath: string; language: string; nodeId: string; symbolCount: number }[] {
    const rows = this.db.prepare(`
      SELECT n.id, n.file_path, n.language,
        (SELECT COUNT(*) FROM nodes s WHERE s.parent_id = n.id AND s.type = 'symbol') as symbol_count
      FROM nodes n WHERE n.type = 'file' AND n.file_path IS NOT NULL
    `).all() as any[]
    return rows.map(r => ({
      filePath: r.file_path,
      language: r.language ?? 'unknown',
      nodeId: r.id,
      symbolCount: r.symbol_count ?? 0,
    }))
  }

  /** Get CALLS dependencies grouped by file pairs for agent consumption */
  getCallGraph(): { fromFile: string; toFile: string; callCount: number; dependencyType: string }[] {
    const rows = this.db.prepare(`
      SELECT
        fn.file_path as from_file,
        tn.file_path as to_file,
        COUNT(*) as call_count,
        e.type as dependency_type
      FROM dependencies e
      JOIN nodes fn ON fn.id = e.src
      JOIN nodes tn ON tn.id = e.dst
      WHERE e.type IN ('CALLS', 'IMPORTS', 'DEPENDS_ON')
        AND fn.file_path IS NOT NULL
        AND tn.file_path IS NOT NULL
        AND fn.file_path != tn.file_path
      GROUP BY fn.file_path, tn.file_path, e.type
      ORDER BY call_count DESC
    `).all() as any[]
    return rows.map(r => ({
      fromFile: r.from_file,
      toFile: r.to_file,
      callCount: r.call_count,
      dependencyType: r.dependency_type,
    }))
  }

  private rowToDependency(row: any): AsmDependency {
    return {
      id: row.id,
      src: row.src,
      dst: row.dst,
      type: row.type as any,
      weight: row.weight ?? 1,
      active: row.active === 1,
      label: row.label ?? undefined,
      agentAuthored: row.agent_authored === 1,
    }
  }

  // ─── Event Log ────────────────────────────────────────────────────────

  logEvent(eventType: string, payload: unknown, author = 'system'): void {
    this.db.prepare(
      'INSERT INTO event_log (event_type, payload, author) VALUES (?, ?, ?)'
    ).run(eventType, JSON.stringify(payload), author)
  }

  logMutation(intent: MutationIntent): void {
    this.db.prepare(`
      INSERT INTO mutation_history (id, intent_type, payload, semantic_hint)
      VALUES (?, ?, ?, ?)
    `).run(intent.id, intent.type, JSON.stringify(intent.payload), intent.semantic_hint)
  }

  getMutationHistory(limit = 50): MutationIntent[] {
    const rows = this.db.prepare(
      'SELECT * FROM mutation_history ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as any[]
    return rows.map(r => ({
      id: r.id,
      type: r.intent_type,
      timestamp: r.created_at,
      semantic_hint: r.semantic_hint ?? '',
      payload: JSON.parse(r.payload),
    }))
  }

  // ─── Full Graph Snapshot ──────────────────────────────────────────────

  getSnapshot(): { nodes: AsmNode[]; dependencies: AsmDependency[]; version: number } {
    return {
      nodes: this.getAllNodes(),
      dependencies: this.getAllDependencies(),
      version: Date.now(),
    }
  }

  /** Snapshot without symbols — for canvas rendering (performance) */
  getCanvasSnapshot(): { nodes: AsmNode[]; dependencies: AsmDependency[]; version: number } {
    return {
      nodes: this.getNodesForCanvas(),
      dependencies: this.getAllDependencies(),
      version: Date.now(),
    }
  }

  // ─── Stats ────────────────────────────────────────────────────────────

  getStats(): { nodeCount: number; dependencyCount: number; fileCount: number; symbolCount: number } {
    const nodeCount = (this.db.prepare('SELECT COUNT(*) as c FROM nodes').get() as any).c
    const dependencyCount = (this.db.prepare('SELECT COUNT(*) as c FROM dependencies').get() as any).c
    const fileCount = (this.db.prepare("SELECT COUNT(*) as c FROM nodes WHERE type='file'").get() as any).c
    const symbolCount = (this.db.prepare("SELECT COUNT(*) as c FROM nodes WHERE type='symbol'").get() as any).c
    return { nodeCount, dependencyCount, fileCount, symbolCount }
  }

  clear(): void {
    this.db.exec('DELETE FROM dependencies; DELETE FROM nodes;')
  }

  close(): void {
    this.db.close()
  }
}
