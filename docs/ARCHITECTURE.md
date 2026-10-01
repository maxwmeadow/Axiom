# Axiom - architecture

How the code is put together today. Verified against `main` on 2026-09-30.
What the product is: [PRODUCT.md](PRODUCT.md). Open work: [../WORK.md](../WORK.md).
Keep this document current: when you change a component's responsibility, a
data flow or a limit named here, update it in the same change.

---

## Processes

```
Electron app (electron/)            Coding agents (Claude Code, Codex, Cursor, ...)
  main process: windows, menus,       |
  project registry, installers,       |  stdio MCP
  updates, logs, file access          v
  renderer (src/renderer): React   MCP server (mcp/axiom-mcp.ts), run by
  + React Flow canvas               `archd mcp-run` on Axiom's bundled Electron Node
        |  HTTP + WebSocket              |  HTTP
        v                                v
            archd (archd-go/): the Go daemon on 127.0.0.1
            indexing, clustering, journal, delta, sheets, inbox,
            infra detection, runtime, per-project SQLite
```

- **archd** listens only on loopback (API `7743`, WebSocket `7744`, runtime
  adapters `7745`), moving to free ports when those are taken and publishing
  the ports it uses in `~/.axiom/data/daemon.json`. Every request carries the
  token from `~/.axiom/data/api-token` (0600); non-loopback `Host` headers are
  refused. An OS lock on the data folder allows one daemon per machine.
- The **app** starts archd, or attaches to one already running (an agent can
  start it headless while the app is closed; a headless daemon exits when idle).
- The **MCP server** finds the project from the agent's working directory and
  starts archd on demand. Agents never need Node installed.
- A legacy TypeScript daemon in `archd/` is still built but never started
  (work item `remove-legacy-archd`).

## Data

- One SQLite database per project: `~/.axiom/data/<project id>/axiom.db`
  (cgo `mattn/go-sqlite3`, WAL, bounded pool). `PRAGMA user_version` carries
  `db.SchemaVersion` (currently 2); a newer database is refused. **Bump
  `SchemaVersion` whenever a migration changes the schema.**
- Daily backups (`backups/`, seven kept), a 30-day trash (`data/.trash`), and
  `.axiommap` export/import (a SQLite snapshot plus a manifest table).
- The project registry, settings and window state are JSON in `~/.axiom`.

## The model

- **Files** (one node each, fixed-size cards) and **symbols** (in files, from
  tree-sitter; not canvas nodes on the Floor).
- **Systems**: semantic groupings of files, nested as a tree; a file belongs
  to one leaf system. Folders never define systems. Sources: `cluster`
  (automatic), `agent`, `user`. Human- and agent-authored systems are protected
  from re-clustering.
- **Relationships**: import edges and a call graph (calls matched by name
  across the project, imports as a tie-breaker; no type resolution), plus
  variable references for data flow (TS/JS, Python, Go).
- **Infrastructure**: nodes with a role (database, cache, queue, storage,
  search, llm, api, auth, platform, observability, email, scheduler, flags,
  realtime), implementations, contracts (tables, topics, cache keys, flags,
  models) and evidence-carrying relationships. See [INFRA.md](INFRA.md).
- **Sheets**: proposals over the Floor (moves, additions, removals) with
  planned elements; revisioned with optimistic concurrency. See
  [SHEET_WORKFLOW.md](SHEET_WORKFLOW.md).
- **Work orders**: addressed inbox messages with leases, frozen sheet
  snapshots and review states. See [INBOX_PROTOCOL.md](INBOX_PROTOCOL.md).
- **Structural journal**: every structural change, attributed to a person or
  an agent session; the source of Review Changes.
- **Roots**: a project can hold several roots (worktrees of one repo); history
  is branch-stamped and collisions between branches are projected onto systems.

## Pipelines

**Indexing** (`internal/indexer`, `internal/parser`, `internal/watcher`):
walk the root with ignore rules and the 1 MB / `*.min.*` limits → parse with
tree-sitter → symbols, imports, calls, variable references, package imports
and environment reads → call graph → clustering → infra detection. fsnotify
watches with a 150 ms file debounce and a 1.5 s re-cluster debounce; hitting
the OS watch limit degrades loudly. Re-scoping (changing which folders are
read) is journaled quietly so it never shows up as code change. Content hashes
make reconcile after a closed period exact.

**Language depth:**

| Languages | Symbols | Import edges | Calls | Data flow | Infra from packages | Runtime |
|---|---|---|---|---|---|---|
| TS/JS, Python, Go | ✅ | ✅ | ✅ | ✅ | ✅ | Node/Python recording; Go via delve |
| C# | ✅ | via `using` + namespaces | ✅ | - | regex | netcoredbg |
| Rust, Java, Ruby | ✅ | - | ✅ | - | regex | Ruby rdbg; Java unverified |
| C++ | ✅ | - | ✅ | - | - | gdb DAP |
| C, Kotlin, Swift, PHP | not parsed | | | | | |

**Clustering** (`internal/cluster`): Louvain over a weighted graph of import
edges (3.0), TF-IDF similarity of symbol and file-name tokens (3.0) and git
co-change (1.5, from `git log`), recursive into nested systems with stable IDs
and TF-IDF names. Agents are asked to author the real tree (`name-architecture`
prompt) rather than repair clusters.

**Review Changes** (`internal/delta`): aggregate the journal to net effect,
compact call sites and imports into claims with evidence, rank them, attribute
them, and classify realisation against sent work orders (MATCHED / FLEXED /
DRIFTED / MISSING / UNKNOWN).

**Work orders** (`internal/api/inbox.go`, `sheet_work.go`): send freezes the
sheet, build spec and comparison in one transaction → an agent claims by ID
(15-minute lease) → builds → `reply_to_canvas` → structural re-comparison →
you accept or request changes. Agent-reported results are labelled unverified.

**Infra detection** (`internal/infradetect`, `internal/registry`): a pure
analysis of package imports, environment reads, the import graph and config
files (compose, `.env`, Dockerfile, Procfile, fly/vercel/netlify/render/railway,
GitHub workflows) against an 87-service registry; results are proposals until
confirmed.

**Investigations and runtime** (`internal/runtime`, `adapters/`): hypothesis
runs record calls in-process (Node load-time instrumentation, Python
`sys.monitoring`); DAP inspection mode for other languages is behind the MCP
debug profile. See [INVESTIGATIONS.md](INVESTIGATIONS.md).

## MCP surface

Fifteen tools by default (`get_architecture`, `search_symbols`, `get_symbols`,
`trace_calls`, `get_data_flow`, `edit_systems`, `edit_infra`, `edit_sheet`,
`get_inbox`, `get_build_plan`, `plan_element`, `reply_to_canvas`,
`start_work`, `update_work`, `investigation`), `debug_runtime` in the debug
profile, and two prompts (`review-canvas`, `name-architecture`). About 80
legacy tool names still route but are not advertised. Budget and merge rules:
[MCP_SURFACE.md](MCP_SURFACE.md). Installers for ten agent hosts live in
`electron/agentInstallers.ts`.

Draw-first guidance has one source, `src/shared/agentWorkflow.ts`, used by
installed mapping/inbox/build skills and MCP connection/prompt instructions.
`electron/agentRules.ts` adds host-specific project rules with hashed managed
blocks; inspection detects missing/edited rules and uninstall keeps authored
text and rules still shared by another configured host. `edit_sheet(connect)`
draws typed planned edges through the existing workspace-scoped sheet API,
validating endpoints against that sheet. Plans and approval use the existing
sheet model; no additional tool or database migration is needed. Host coverage
and validation limits are in [testing/AGENTS_DRAW_FIRST.md](testing/AGENTS_DRAW_FIRST.md).

## Renderer

React + React Flow (`@xyflow/react` 12) with zustand stores. The canvas is
`src/renderer/canvas/` (~21k lines; `AxiomCanvas.tsx` alone is ~5k and is
work item `split-axiom-canvas`). Semantic zoom reveals contents by on-screen
size; layout is deterministic frame packing that never moves persisted
geometry. One command model (`src/shared/appMenu.ts`) drives menus, the
palette, shortcuts and right-click menus. The renderer is sandboxed under a
strict CSP; privileged work goes through `electron/preload.ts`.

## Tests and CI

- `npm run test:renderer` - node unit tests for renderer, shared, Electron,
  MCP, adapters and scripts.
- `cd archd-go && go test ./...` - daemon tests (runtime and clustering
  quality are thinly covered).
- `npm run test:mcp` - MCP end-to-end against a real archd. **Not in CI.**
- `npm run test:e2e` - Playwright journeys in Electron. **Not in CI.**
- CI (`.github/workflows/ci.yml`) runs Go vet and tests, the license check,
  the unit suite, the typecheck and the build on Linux, macOS and Windows.

## Known limits

- Single-machine, single-user; no sync.
- The MCP connection binds to one root; multi-folder projects are held.
- Name-matched calls can create false edges; languages outside TS/JS, Python
  and Go get a weaker map.
- Full re-cluster reads the whole git history and rebuilds the root graph;
  not benchmarked on very large repos.
- macOS auto-update needs code signing.
