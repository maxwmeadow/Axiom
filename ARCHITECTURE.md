# Axiom - Architecture Reference

> Last updated: 2026-06-22  
> This document captures the core architectural decisions made during the design phase. It is the source of truth for how Axiom is structured, what each layer means, and how the major subsystems interact.

---

## What Axiom Is

Axiom is a **bidirectional, local-first codebase visualizer**. It maps any codebase into a structured graph, stores that graph locally, exposes it to AI agents via MCP, and displays it on an interactive canvas. The central idea is that expensive LLMs never have to figure out what a codebase is - a human or a previous agent already told Axiom, and the next agent just reads it.

Two actors have equal write access to the graph: **the human** (via the canvas UI) and **the agent** (via MCP tools). Changes from either are immediately reflected in both the database and the canvas.

---

## The Four Node Types

### 1. System
A **semantic grouping of files** representing a real feature or domain boundary. Not tied to directory structure. The canonical organizational unit of Axiom.

- Defined by: user (lasso select + name) or agent (MCP `create_system` / `assign_file_to_system`)
- Systems form a **tree**: a system can contain sub-systems (e.g., "World Generation" contains "Biome Generation" and "Climate System")
- A file belongs to exactly one leaf system. Its membership in ancestor systems is implicit via the tree traversal
- Depth is unlimited in the data model; the canvas enforces a display cap of ~3 levels for readability
- `source` field tracks whether a system was created by directory auto-grouping, the user, or an agent

### 2. File
An individual source file. The **primary unit of the canvas** - always visible regardless of zoom level.

- Carries: language, path, line count, system assignment, churn score
- Clicking a file opens its symbol list in the detail panel (symbols are not canvas nodes)
- Files are the targets of import/call graph edges

### 3. Infra
An external dependency that your code talks to but that isn't source code. Databases, queues, platforms, external APIs.

- Examples: Postgres, Redis, Vercel, Railway, Stripe API, another microservice
- Eventually typed with canonical icons (a Postgres node looks like Postgres)
- Connected to files/systems via edges (a file that talks to Postgres gets a `READS_DB` or `CALLS` edge to the Postgres infra node)
- Positioned alongside systems on the canvas, not nested inside them

### 4. Call Graph (not a node type - an edge layer)
The output of recursive tree-sitter function call mapping. Every function call in every file is recorded as a directed edge at the symbol level. These edges are **aggregated for display** rather than shown individually.

| Canvas zoom level | What is rendered |
|---|---|
| Far out (system view) | Bundled edge: "System A → System B (142 call paths)" |
| Mid (file view) | File-to-file edges: imports, direct calls |
| Close (file detail) | Individual function call traces on demand |

The MCP agent uses the raw call graph DB directly for debugging traces - it never needs the canvas to render all 10,000 edges at once.

---

## Removed Concepts

### ~~Service~~
Removed. The project title (e.g., "Project Radial") is displayed in the app titlebar only. It is not a canvas node. There is no green box that contains everything.

### ~~Module (as a structural node)~~
Removed as a ReactFlow node type. Replaced by **System** (semantically defined) and directory-based auto-grouping on first index (see Classification Loop below).

### ~~Symbol (as a canvas node)~~
Removed from the canvas. Symbols exist in the database and are accessible via:
- The detail panel (click a file to see its symbols)
- The MCP agent (trace calls, find definitions)
- Call graph edge aggregation (contributes to edge weight counts)

---

## Multi-Repo / Workspace Model

One Axiom **project** = one **workspace** = N code roots.

A workspace can contain a backend repo, a frontend repo, and a Chrome extension repo simultaneously. Each root is parsed by archd independently, but all their systems and files share the same SQLite graph and the same canvas. Cross-root edges (a frontend file calling a backend API) are regular directed edges in the graph - the root origin is metadata on the node, not a structural container.

The project title in the toolbar is the workspace name ("My SaaS App"). The canvas shows all systems from all roots floating together, with connections between them.

---

## Data Model

```sql
-- Workspaces (one per Axiom project)
workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  opened_at   INTEGER,
  roots       TEXT  -- json array of root paths
)

-- Code roots within a workspace
roots (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT REFERENCES workspaces(id),
  path          TEXT NOT NULL,
  language      TEXT,
  indexed_at    INTEGER
)

-- Systems tree (the semantic organizational layer)
systems (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  parent_id     TEXT REFERENCES systems(id),  -- null = top-level
  source        TEXT NOT NULL,  -- 'directory' | 'user' | 'agent'
  color         TEXT,
  description   TEXT,
  depth         INTEGER DEFAULT 0,  -- cached, computed from parent chain
  agent_notes   TEXT,  -- agent-written context about this system
  position_x    REAL,
  position_y    REAL,
  created_at    INTEGER,
  updated_at    INTEGER
)

-- Files (the primary canvas unit)
files (
  id            TEXT PRIMARY KEY,
  root_id       TEXT REFERENCES roots(id),
  path          TEXT NOT NULL,
  language      TEXT,
  system_id     TEXT REFERENCES systems(id),
  line_count    INTEGER,
  churn_score   REAL DEFAULT 0,   -- normalized commit frequency
  indexed_at    INTEGER
)

-- Infra nodes
infra_nodes (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  infra_type    TEXT,  -- 'postgres' | 'redis' | 'vercel' | 'stripe' | 'custom' | ...
  config        TEXT,  -- json: connection string hint, region, etc.
  position_x    REAL,
  position_y    REAL
)

-- All graph edges (structural + semantic + call graph)
edges (
  id            TEXT PRIMARY KEY,
  src           TEXT NOT NULL,  -- file id, system id, or infra id
  dst           TEXT NOT NULL,
  src_type      TEXT NOT NULL,  -- 'file' | 'system' | 'infra'
  dst_type      TEXT NOT NULL,
  edge_type     TEXT NOT NULL,  -- 'IMPORTS' | 'CALLS' | 'DEPENDS_ON' | 'READS_DB' | ...
  weight        INTEGER DEFAULT 1,  -- call count or import frequency
  created_by    TEXT,  -- 'parser' | 'agent' | 'user'
  workspace_id  TEXT
)

-- Call graph at symbol level (for deep tracing)
call_graph (
  caller_file   TEXT REFERENCES files(id),
  caller_symbol TEXT,  -- function name
  callee_file   TEXT REFERENCES files(id),
  callee_symbol TEXT,
  call_count    INTEGER DEFAULT 1
)
```

---

## Initial State: First Index

When a workspace is first indexed, Axiom has no system assignments. The default behavior:

1. archd walks the directory tree and creates one **System per top-level subdirectory**
2. All files are assigned to their nearest directory-based system
3. These systems have `source = 'directory'`
4. The canvas renders them immediately - the user sees a real structure, not a blank canvas
5. The status shows: "229 files in 12 auto-systems. Run agent review to organize by feature."

Directory-based systems are the starting point, not the destination. They exist so the canvas is immediately useful before any agent work is done.

---

## System Organization (Clustering + Agent Review)

> The original design here was a stateful "classification job" pipeline (batch
> tables, `/api/classification/*` endpoints) where the agent classified every
> file from scratch. It was superseded before ever being wired to MCP or the UI
> and was removed in July 2026. The actual flow:

1. **Indexing clusters automatically (~85%)** - `clusterAndAssign` in the
   indexer runs hierarchical multi-signal clustering (TF-IDF over symbols +
   git co-change + import connectivity), creating nested systems with
   `source='cluster'` up to 4 levels deep. No LLM involved.
2. **Agent review finishes the rest** - the `start_review` MCP tool hands the
   agent audit instructions; it inspects the clustered systems and reorganizes
   using the ad-hoc tools (`get_unclassified_files`, `create_system`,
   `assign_files_to_system`, `update_systems_bulk`, `merge_systems`, …).
3. Every change broadcasts over WebSocket and the canvas re-renders live.

The proposal pattern from the original design (pending assignments with
confidence + accept/reject) lives on in the infra layer's detection tray -
see INFRA_LAYER_PLAN.md.

---

## Canvas Architecture

### Node Hierarchy on Canvas

```
Workspace
  ├── System (top-level)          ← compound node, expand/collapse
  │     ├── Sub-system            ← compound node, expand/collapse
  │     │     ├── file.ts         ← always-visible file card
  │     │     └── utils.ts
  │     ├── other-file.ts         ← direct file child
  │     └── ...
  ├── System (top-level)
  │     └── ...
  └── [Infra: Postgres]           ← standalone node, no nesting
```

### Expand/Collapse (not zoom-tier opacity)

Systems use an **explicit expand/collapse** model, not the previous opacity-fade-by-zoom model.

- Default: all top-level systems **collapsed** (compact card showing name + file count)
- Click system → expands to show direct file children and sub-systems
- Double-click sub-system → expands it in place
- The canvas re-layouts the expanded node and adjusts surrounding nodes
- `fitView` recenters on the expanded area

At very high zoom (≥ 1.5), systems auto-expand if they haven't been explicitly collapsed. At very low zoom (≤ 0.15), all systems collapse to compact cards.

### File Cards (always rendered, fixed size)

File cards are the primary interactive unit. They are always visible when their parent system is expanded. Fixed dimensions: `180 × 72px`.

Card content:
- Language icon (TS, Python, Go, etc.)
- Filename
- Line count
- Module badge (which sub-system/directory it came from, if relevant)
- Churn indicator (thin colored left border - red = high churn)

On click: opens detail panel showing file metadata, symbol list, and active call graph edges.

### Edge LOD (Level of Detail)

| Canvas state | Edges shown |
|---|---|
| All systems collapsed | System → System bundled edges with weight label |
| One system expanded | File → File edges within + System → System for external |
| Two files selected | Full call path between them (demand-loaded) |
| Agent tracing | Highlighted subgraph of the trace path |

The canvas never renders all call graph edges simultaneously. Edge rendering is always viewport-culled and LOD-gated.

---

## Bidirectionality

Every action has two entry points - one for the user and one for the agent. The database is the single source of truth. The canvas reflects whatever is in the database.

| Action | User path | Agent path |
|---|---|---|
| Create a system | Lasso select files → name dialog | `create_system(name, file_ids)` |
| Assign file to system | Drag file into system on canvas | `assign_file_to_system(file_id, system_id)` |
| Rename system | Double-click system label | `rename_system(system_id, new_name)` |
| Nest system | Drag system onto another system | `set_system_parent(child_id, parent_id)` |
| Connect to infra | Draw edge to infra node | `create_infra_connection(file_id, infra_id, edge_type)` |
| Trigger reorganization | "Organize" button | `start_review()` |
| View call trace | Click file → expand in panel | `trace_call_path(from_symbol, to_symbol)` |

---

## archd (The Parser Daemon)

archd runs as a local background process. It:
1. Watches the filesystem for changes
2. Parses files with tree-sitter (TypeScript, JavaScript, Python, Go, Rust, C#)
3. Updates the SQLite graph
4. Broadcasts diffs to the renderer via WebSocket
5. Serves the agent-api HTTP endpoints consumed by the MCP server

On first index: creates directory-based systems, parses all files, builds the initial call graph.
On file change: re-parses the changed file, updates its edges, broadcasts a graph patch.

---

## MCP Server

The MCP server (`axiom-mcp.ts`) wraps the agent-api endpoints and exposes them as MCP tools. The agent never talks directly to the database or to archd - it always goes through MCP.

The tool surface has grown well beyond this list - see `mcp/axiom-mcp.ts` for the current set (system CRUD, graph queries, runtime tracing, investigations, data flow, infra).

---

## Rendering Scale Strategy

The current renderer (TypeScript + ReactFlow) handles ~500 nodes comfortably. For large codebases:

1. **Viewport culling**: only nodes whose bounding box intersects the current viewport are rendered. ReactFlow handles some of this; additional culling is needed for large graphs.
2. **Edge LOD**: only render the appropriate edge tier for the current zoom level. Never render raw call graph edges on the canvas.
3. **Demand loading**: symbol-level data (call graph detail) is loaded only when a file is clicked, not on initial graph load.
4. **Compact collapsed state**: a collapsed system is one ReactFlow node regardless of how many files it contains. The file nodes are only added to the React tree when the system is expanded.

---

## Open Questions / Future Work

- **Infra typed nodes**: Define a canonical set of infra types with icons (Postgres, Redis, Vercel, Railway, Stripe, custom HTTP, etc.)
- **Cross-workspace connections**: Can two separate Axiom workspaces reference each other?
- **Call graph storage scale**: At 10,000+ files, the call_graph table may have millions of rows. Consider columnar storage or an embedded graph DB (DuckDB, RocksDB) for the call graph specifically.
- **Real-time collaboration**: Multiple users editing system assignments simultaneously - conflict resolution strategy TBD.
- **Classification quality feedback**: User can accept/reject/modify agent classifications. This feedback could train a local model over time.
