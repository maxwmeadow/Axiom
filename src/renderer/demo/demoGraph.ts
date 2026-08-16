import type { CanvasSnapshot } from '../../shared/types'

// Synthetic demo graph representing the Axiom codebase itself.
// Used in browser mode (no Electron, no archd running).

export const DEMO_WORKSPACE_ID = 'demo'

export const demoSnapshot: CanvasSnapshot = {
  workspaceId: DEMO_WORKSPACE_ID,

  systems: [
    // ── Top-level systems ────────────────────────────────────────────────
    {
      id: 'sys_canvas',
      workspaceId: DEMO_WORKSPACE_ID,
      name: 'Canvas Renderer',
      parentId: null,
      source: 'directory',
      color: '#6366f1',
      description: 'ReactFlow canvas, node components, layout engine',
      agentNotes: null,
      depth: 0,
      positionX: 0,
      positionY: 0,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: 'sys_daemon',
      workspaceId: DEMO_WORKSPACE_ID,
      name: 'archd Daemon',
      parentId: null,
      source: 'directory',
      color: '#10b981',
      description: 'Go parser daemon - file indexer, watcher, REST API',
      agentNotes: null,
      depth: 0,
      positionX: 0,
      positionY: 0,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: 'sys_mcp',
      workspaceId: DEMO_WORKSPACE_ID,
      name: 'MCP Server',
      parentId: null,
      source: 'agent',
      color: '#f59e0b',
      description: 'MCP tools exposing the graph to AI agents',
      agentNotes: 'Created by agent: groups all agent-facing endpoints',
      depth: 0,
      positionX: 0,
      positionY: 0,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: 'sys_shared',
      workspaceId: DEMO_WORKSPACE_ID,
      name: 'Shared Types',
      parentId: null,
      source: 'directory',
      color: '#3b82f6',
      description: 'TypeScript types shared between renderer, Electron, and MCP',
      agentNotes: null,
      depth: 0,
      positionX: 0,
      positionY: 0,
      createdAt: 0,
      updatedAt: 0,
    },

    // ── Subsystems ────────────────────────────────────────────────────────
    {
      id: 'sys_nodes',
      workspaceId: DEMO_WORKSPACE_ID,
      name: 'Node Components',
      parentId: 'sys_canvas',
      source: 'directory',
      color: '#8b5cf6',
      description: 'SystemNode, FileNode, InfraNode ReactFlow components',
      agentNotes: null,
      depth: 1,
      positionX: 0,
      positionY: 0,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: 'sys_db',
      workspaceId: DEMO_WORKSPACE_ID,
      name: 'Database Layer',
      parentId: 'sys_daemon',
      source: 'directory',
      color: '#06b6d4',
      description: 'SQLite schema and typed CRUD operations',
      agentNotes: null,
      depth: 1,
      positionX: 0,
      positionY: 0,
      createdAt: 0,
      updatedAt: 0,
    },
  ],

  files: [
    // ── Canvas Renderer ──────────────────────────────────────────────────
    { id: 'file_canvas', rootId: 'root_demo', path: '/axiom/src/renderer/canvas/AxiomCanvas.tsx', relPath: 'src/renderer/canvas/AxiomCanvas.tsx', language: 'tsx', systemId: 'sys_canvas', lineCount: 420, churnScore: 0.85, positionX: 0, positionY: 0, indexedAt: 0 },
    { id: 'file_store', rootId: 'root_demo', path: '/axiom/src/renderer/store/graphStore.ts', relPath: 'src/renderer/store/graphStore.ts', language: 'typescript', systemId: 'sys_canvas', lineCount: 112, churnScore: 0.6, positionX: 0, positionY: 0, indexedAt: 0 },
    { id: 'file_layerzoom', rootId: 'root_demo', path: '/axiom/src/renderer/canvas/hooks/useLayerZoom.ts', relPath: 'src/renderer/canvas/hooks/useLayerZoom.ts', language: 'typescript', systemId: 'sys_canvas', lineCount: 48, churnScore: 0.2, positionX: 0, positionY: 0, indexedAt: 0 },

    // ── Node Components (subsystem of Canvas) ────────────────────────────
    { id: 'file_systemnode', rootId: 'root_demo', path: '/axiom/src/renderer/canvas/nodes/SystemNode.tsx', relPath: 'src/renderer/canvas/nodes/SystemNode.tsx', language: 'tsx', systemId: 'sys_nodes', lineCount: 155, churnScore: 0.7, positionX: 0, positionY: 0, indexedAt: 0 },
    { id: 'file_filenode', rootId: 'root_demo', path: '/axiom/src/renderer/canvas/nodes/FileNode.tsx', relPath: 'src/renderer/canvas/nodes/FileNode.tsx', language: 'tsx', systemId: 'sys_nodes', lineCount: 183, churnScore: 0.3, positionX: 0, positionY: 0, indexedAt: 0 },
    { id: 'file_infranode', rootId: 'root_demo', path: '/axiom/src/renderer/canvas/nodes/InfraNode.tsx', relPath: 'src/renderer/canvas/nodes/InfraNode.tsx', language: 'tsx', systemId: 'sys_nodes', lineCount: 64, churnScore: 0.1, positionX: 0, positionY: 0, indexedAt: 0 },

    // ── archd Daemon ─────────────────────────────────────────────────────
    { id: 'file_main', rootId: 'root_demo', path: '/axiom/archd-go/cmd/archd/main.go', relPath: 'archd-go/cmd/archd/main.go', language: 'go', systemId: 'sys_daemon', lineCount: 130, churnScore: 0.4, positionX: 0, positionY: 0, indexedAt: 0 },
    { id: 'file_indexer', rootId: 'root_demo', path: '/axiom/archd-go/internal/indexer/indexer.go', relPath: 'archd-go/internal/indexer/indexer.go', language: 'go', systemId: 'sys_daemon', lineCount: 220, churnScore: 0.6, positionX: 0, positionY: 0, indexedAt: 0 },
    { id: 'file_parser', rootId: 'root_demo', path: '/axiom/archd-go/internal/parser/parser.go', relPath: 'archd-go/internal/parser/parser.go', language: 'go', systemId: 'sys_daemon', lineCount: 195, churnScore: 0.5, positionX: 0, positionY: 0, indexedAt: 0 },
    { id: 'file_watcher', rootId: 'root_demo', path: '/axiom/archd-go/internal/watcher/watcher.go', relPath: 'archd-go/internal/watcher/watcher.go', language: 'go', systemId: 'sys_daemon', lineCount: 92, churnScore: 0.2, positionX: 0, positionY: 0, indexedAt: 0 },

    // ── Database Layer (subsystem of archd) ──────────────────────────────
    { id: 'file_dbgo', rootId: 'root_demo', path: '/axiom/archd-go/internal/db/db.go', relPath: 'archd-go/internal/db/db.go', language: 'go', systemId: 'sys_db', lineCount: 182, churnScore: 0.3, positionX: 0, positionY: 0, indexedAt: 0 },
    { id: 'file_store_go', rootId: 'root_demo', path: '/axiom/archd-go/internal/db/store.go', relPath: 'archd-go/internal/db/store.go', language: 'go', systemId: 'sys_db', lineCount: 480, churnScore: 0.7, positionX: 0, positionY: 0, indexedAt: 0 },

    // ── MCP Server ────────────────────────────────────────────────────────
    { id: 'file_mcp', rootId: 'root_demo', path: '/axiom/mcp/axiom-mcp.ts', relPath: 'mcp/axiom-mcp.ts', language: 'typescript', systemId: 'sys_mcp', lineCount: 280, churnScore: 0.4, positionX: 0, positionY: 0, indexedAt: 0 },

    // ── Shared Types ──────────────────────────────────────────────────────
    { id: 'file_types', rootId: 'root_demo', path: '/axiom/src/shared/types.ts', relPath: 'src/shared/types.ts', language: 'typescript', systemId: 'sys_shared', lineCount: 230, churnScore: 0.9, positionX: 0, positionY: 0, indexedAt: 0 },
  ],

  infraNodes: [
    { id: 'infra_sqlite', workspaceId: DEMO_WORKSPACE_ID, name: 'SQLite DB', infraType: 'sqlite', category: 'database', provider: 'sqlite', service: 'sqlite/sqlite', subtype: 'sql', status: 'confirmed', positionX: 0, positionY: 0 },
    { id: 'infra_mcp_proto', workspaceId: DEMO_WORKSPACE_ID, name: 'MCP Protocol', infraType: 'custom', category: 'api', provider: 'generic', service: '', subtype: '', status: 'confirmed', positionX: 0, positionY: 0 },
  ],

  dependencies: [
    { id: 'e1',  workspaceId: DEMO_WORKSPACE_ID, src: 'file_canvas',    dst: 'file_types',     srcType: 'file', dstType: 'file',  dependencyType: 'IMPORTS',  weight: 1, createdBy: 'parser' },
    { id: 'e2',  workspaceId: DEMO_WORKSPACE_ID, src: 'file_store',     dst: 'file_types',     srcType: 'file', dstType: 'file',  dependencyType: 'IMPORTS',  weight: 1, createdBy: 'parser' },
    { id: 'e3',  workspaceId: DEMO_WORKSPACE_ID, src: 'file_canvas',    dst: 'file_store',     srcType: 'file', dstType: 'file',  dependencyType: 'IMPORTS',  weight: 3, createdBy: 'parser' },
    { id: 'e4',  workspaceId: DEMO_WORKSPACE_ID, src: 'file_canvas',    dst: 'file_layerzoom', srcType: 'file', dstType: 'file',  dependencyType: 'IMPORTS',  weight: 2, createdBy: 'parser' },
    { id: 'e5',  workspaceId: DEMO_WORKSPACE_ID, src: 'file_systemnode',dst: 'file_types',     srcType: 'file', dstType: 'file',  dependencyType: 'IMPORTS',  weight: 1, createdBy: 'parser' },
    { id: 'e6',  workspaceId: DEMO_WORKSPACE_ID, src: 'file_filenode',  dst: 'file_types',     srcType: 'file', dstType: 'file',  dependencyType: 'IMPORTS',  weight: 1, createdBy: 'parser' },
    { id: 'e7',  workspaceId: DEMO_WORKSPACE_ID, src: 'file_canvas',    dst: 'file_systemnode',srcType: 'file', dstType: 'file',  dependencyType: 'IMPORTS',  weight: 1, createdBy: 'parser' },
    { id: 'e8',  workspaceId: DEMO_WORKSPACE_ID, src: 'file_canvas',    dst: 'file_filenode',  srcType: 'file', dstType: 'file',  dependencyType: 'IMPORTS',  weight: 1, createdBy: 'parser' },
    { id: 'e9',  workspaceId: DEMO_WORKSPACE_ID, src: 'file_main',      dst: 'file_indexer',   srcType: 'file', dstType: 'file',  dependencyType: 'IMPORTS',  weight: 1, createdBy: 'parser' },
    { id: 'e10', workspaceId: DEMO_WORKSPACE_ID, src: 'file_indexer',   dst: 'file_parser',    srcType: 'file', dstType: 'file',  dependencyType: 'IMPORTS',  weight: 2, createdBy: 'parser' },
    { id: 'e11', workspaceId: DEMO_WORKSPACE_ID, src: 'file_indexer',   dst: 'file_store_go',  srcType: 'file', dstType: 'file',  dependencyType: 'IMPORTS',  weight: 3, createdBy: 'parser' },
    { id: 'e12', workspaceId: DEMO_WORKSPACE_ID, src: 'file_dbgo',      dst: 'file_store_go',  srcType: 'file', dstType: 'file',  dependencyType: 'IMPORTS',  weight: 1, createdBy: 'parser' },
    { id: 'e13', workspaceId: DEMO_WORKSPACE_ID, src: 'file_store_go',  dst: 'infra_sqlite',   srcType: 'file', dstType: 'infra', dependencyType: 'READS_DB', weight: 5, createdBy: 'parser' },
    { id: 'e14', workspaceId: DEMO_WORKSPACE_ID, src: 'file_dbgo',      dst: 'infra_sqlite',   srcType: 'file', dstType: 'infra', dependencyType: 'READS_DB', weight: 2, createdBy: 'parser' },
    { id: 'e15', workspaceId: DEMO_WORKSPACE_ID, src: 'file_mcp',       dst: 'file_types',     srcType: 'file', dstType: 'file',  dependencyType: 'IMPORTS',  weight: 1, createdBy: 'parser' },
    { id: 'e16', workspaceId: DEMO_WORKSPACE_ID, src: 'file_mcp',       dst: 'infra_mcp_proto',srcType: 'file', dstType: 'infra', dependencyType: 'CALLS',    weight: 4, createdBy: 'parser' },
  ],
}
