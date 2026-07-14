// ─── ASM Layer Hierarchy ───────────────────────────────────────────────────

export type Layer = 'INFRA' | 'SERVICE' | 'MODULE' | 'FILE' | 'SYMBOL'

export const LAYER_ORDER: Layer[] = ['INFRA', 'SERVICE', 'MODULE', 'FILE', 'SYMBOL']

/** Legacy zoom thresholds kept for minimap coloring — canvas now uses semanticDepth */
export const LAYER_ZOOM_THRESHOLDS: Record<Layer, [number, number]> = {
  INFRA:   [0,    0.15],
  SERVICE: [0.15, 0.4],
  MODULE:  [0.4,  0.8],
  FILE:    [0.8,  2.0],
  SYMBOL:  [2.0,  Infinity],
}

// ─── Semantic zoom thresholds per depth ────────────────────────────────────
// Each node has a `semanticDepth` (0 = top-level system, 1 = subsystem, etc.)
// These thresholds control when children fade in as you zoom into their parent.

export const DEPTH_REVEAL_ZOOM: number[] = [0.0, 0.25, 0.60, 1.30]
export const DEPTH_REVEAL_RANGE = 0.20   // transition window in zoom units
export const DEPTH_GHOST_ZOOM: number[]  = [99,  0.50, 1.00, 99  ]  // when parent bg ghostifies

// ─── ASM Core Types ────────────────────────────────────────────────────────

export type NodeType =
  | 'infra'
  | 'service'
  | 'module'
  | 'file'
  | 'symbol'

export type DependencyType =
  | 'IMPORTS'
  | 'CALLS'
  | 'EXPORTS'
  | 'DEPENDS_ON'
  | 'CONTAINS'
  | 'READS_DB'
  | 'EMITS_EVENT'
  | 'PUBLISHES_EVENT'
  | 'DATA_FLOW'       // agent-authored semantic data flow
  | 'INHERITS'        // class inheritance
  | 'IMPLEMENTS'      // interface implementation

export interface AsmNode {
  id: string
  type: NodeType
  layer: Layer
  label: string
  filePath?: string
  language?: string
  lineCount?: number
  childCount: number
  parentId?: string
  position: { x: number; y: number }
  metadata: Record<string, unknown>
  // Semantic zoom
  semanticDepth: number       // 0 = top-level system, 1 = subsystem, 2 = file, 3 = symbol
  // runtime
  agentTouched?: boolean
  churnScore?: number         // 0–1, normalized commit frequency
  agentAuthored?: boolean     // true if an AI agent created/placed this node
}

export interface AsmDependency {
  id: string
  src: string
  dst: string
  type: DependencyType
  weight: number
  active: boolean
  label?: string              // semantic description of the connection
  bundled?: boolean
  bundleCount?: number
  agentAuthored?: boolean
}

export interface AsmGraph {
  nodes: AsmNode[]
  dependencies: AsmDependency[]
  version: number
}

// ─── WebSocket message types ────────────────────────────────────────────────

export type WsMessage =
  // Legacy demo / TypeScript archd messages
  | { type: 'graph:snapshot'; payload: AsmGraph }
  | { type: 'graph:patch'; payload: GraphPatch }
  | { type: 'agent:activity'; payload: AgentActivity }
  | { type: 'indexing:progress'; payload: IndexingProgress }
  | { type: 'indexing:complete'; payload: { totalNodes: number } }
  | { type: 'indexing:agent_ready'; payload: { totalFiles: number; totalNodes: number; mcpEndpoint: string } }
  // Go archd messages
  | { type: 'indexing:progress'; payload: { indexed: number; total: number } }
  | { type: 'indexing:complete'; payload: { workspaceId: string } }

export interface GraphPatch {
  addedNodes: AsmNode[]
  removedNodeIds: string[]
  updatedNodes: AsmNode[]
  addedDependencies: AsmDependency[]
  removedDependencyIds: string[]
}

export interface AgentActivity {
  touchedNodeIds: string[]
  query: string
  tool: string
  timestamp: number
  tokenCount: number
}

export interface IndexingProgress {
  filesProcessed: number
  filesTotal: number
  currentFile: string
}

// ─── GQP Protocol Types ────────────────────────────────────────────────────

export interface GqpQueryRequest {
  focus: string
  hops?: number
  layers?: Layer[]
  dependency_types?: DependencyType[]
  exclude?: string[]
  return?: string[]
}

export interface GqpTraceRequest {
  entry_point: string
  follow?: DependencyType[]
  max_depth?: number
}

export interface GqpSubgraph {
  nodes: AsmNode[]
  dependencies: AsmDependency[]
  totalNodes: number
  estimatedTokens: number
}

// ─── MutationIntent Types ──────────────────────────────────────────────────

export type MutationIntentType =
  | 'REROUTE_EDGE'
  | 'EXTRACT_MODULE'
  | 'DELETE_EDGE'
  | 'MOVE_FILE'
  | 'MERGE_MODULES'
  | 'CREATE_SYSTEM'
  | 'ASSIGN_FILE'

export interface MutationIntent {
  id: string
  type: MutationIntentType
  timestamp: number
  semantic_hint: string
  constraint?: string
  payload: Record<string, unknown>
}

// ─── Project Config ────────────────────────────────────────────────────────

export interface ProjectConfig {
  id: string
  name: string
  rootPath: string
  ignoredPaths: string[]
  languageOverrides: Record<string, string>
  layoutPreferences: {
    zoom: number
    panX: number
    panY: number
  }
  openedAt: number
  indexedAt?: number
  agentReadyAt?: number       // timestamp when raw index finished and agent can start
}

// ─── Go archd backend types ─────────────────────────────────────────────────
// These match the JSON structs in archd-go/internal/db/store.go exactly.

export interface DbWorkspace {
  id: string
  name: string
  openedAt: number
}

export interface DbRoot {
  id: string
  workspaceId: string
  path: string
  indexedAt: number | null
}

/** A semantic grouping of files. Systems form a tree via parentId. */
export interface DbSystem {
  id: string
  workspaceId: string
  name: string
  parentId: string | null
  source: 'directory' | 'user' | 'agent' | 'cluster'
  color: string | null
  description: string | null
  agentNotes: string | null
  depth: number
  positionX: number
  positionY: number
  width?: number | null
  height?: number | null
  createdAt: number
  updatedAt: number
}

export interface DbFile {
  id: string
  rootId: string
  path: string
  relPath: string
  language: string
  systemId: string | null
  lineCount: number
  /** 0–1 display heat: percentile rank of decayed live-edit activity within the workspace. */
  churnScore: number
  /** Raw decayed activity score + its decay anchor (activity engine). */
  activityScore?: number
  activityAt?: number
  /** Inferred semantic shape ('' | 'class' | 'cylinder' | 'hexagon'); override wins. */
  shape?: string
  shapeOverride?: string
  /** Class-first title when the file IS its class. */
  displayName?: string
  positionX: number
  positionY: number
  width?: number | null
  height?: number | null
  indexedAt: number
}

export interface DbSymbol {
  id: string
  fileId: string
  name: string
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method'
  lineStart: number
  lineEnd: number
}

export interface DbDependency {
  id: string
  workspaceId: string
  src: string
  dst: string
  srcType: 'file' | 'system' | 'infra'
  dstType: 'file' | 'system' | 'infra'
  /** Structural kinds plus category-typed infra kinds (READS, WRITES, PUBLISHES, ...). */
  dependencyType: string
  weight: number
  createdBy: 'parser' | 'agent' | 'user'
  /** file:line justifying an infra edge. */
  evidence?: string | null
}

/** Infra category — the semantic role that defines edge kinds and silhouette. */
export type InfraCategory =
  | 'database' | 'cache' | 'queue' | 'storage' | 'search' | 'llm'
  | 'api' | 'auth' | 'platform' | 'cdn' | 'observability' | 'email'

export interface DbInfraNode {
  id: string
  workspaceId: string
  name: string
  /** @deprecated superseded by category/provider/service */
  infraType: string
  category: InfraCategory
  provider: string
  /** Registry service id ('aws/rds'); '' = unassigned generic node. */
  service: string
  subtype: string
  status: 'proposed' | 'confirmed' | 'dismissed'
  detectedBy?: unknown
  config?: Record<string, unknown>
  positionX: number
  positionY: number
}

/** One entry of the infra service registry (GET /api/registry/services). */
export interface InfraService {
  id: string
  name: string
  category: InfraCategory
  subtype?: string
  provider: string
  brand: { icon: string; color: string; darkColor?: string }
  configFields?: string[]
  layer?: 'embedded' | 'user' | 'workspace'
}

export interface InfraRegistry {
  categories: { id: InfraCategory; edgeKinds: string[] }[]
  services: InfraService[]
}

/** Full graph snapshot sent by Go archd over WebSocket on connect or full refresh. */
export interface CanvasSnapshot {
  workspaceId: string
  systems: DbSystem[]
  files: DbFile[]
  infraNodes: DbInfraNode[]
  dependencies: DbDependency[]
}

/** Incremental patch sent by Go archd when a single entity changes. */
export interface DbGraphPatch {
  type:
    | 'system:upserted' | 'system:deleted'
    | 'file:updated'    | 'file:assigned'
    | 'infra:upserted'  | 'infra:deleted'
    | 'infra:connected' | 'infra:disconnected'
  payload: DbSystem | DbFile | DbInfraNode | DbDependency | { id: string } | { fileId: string; systemId: string }
}
