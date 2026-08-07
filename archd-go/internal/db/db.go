// Package db manages the SQLite database that is archd's single source of truth.
// Every system assignment, file record, edge, and infra node lives here.
// The canvas and MCP layer are purely read/write clients of this store.
package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "github.com/mattn/go-sqlite3"
)

const (
	// SQLite still permits a single writer, but WAL mode lets readers continue
	// while that writer is active. A bounded pool prevents watcher writes from
	// occupying the only connection and stalling API reads behind them.
	maxOpenConnections = 8
	busyTimeoutMillis  = 5000
)

// Open creates (or opens) the SQLite database at the given path and runs
// all schema migrations. Returns a ready-to-use *sql.DB.
func Open(dataDir string) (*sql.DB, error) {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	dbPath := filepath.Join(dataDir, "axiom.db")
	dsn := fmt.Sprintf(
		"%s?_foreign_keys=on&_journal_mode=WAL&_synchronous=NORMAL&_busy_timeout=%d&_txlock=immediate",
		dbPath,
		busyTimeoutMillis,
	)
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	db.SetMaxOpenConns(maxOpenConnections)
	db.SetMaxIdleConns(maxOpenConnections)

	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	return db, nil
}

// migrate applies all schema definitions idempotently via CREATE TABLE IF NOT EXISTS.
// Add new tables here; never alter existing columns (add new migrations below instead).
func migrate(db *sql.DB) error {
	// Rename old edges table/column if they exist
	var hasEdges int
	err := db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='edges'").Scan(&hasEdges)
	if err == nil && hasEdges > 0 {
		// Table exists, rename it
		if _, err := db.Exec("ALTER TABLE edges RENAME TO dependencies"); err == nil {
			// Try to rename column (ignoring error if already renamed or unsupported)
			_, _ = db.Exec("ALTER TABLE dependencies RENAME COLUMN edge_type TO dependency_type")
		}
	} else {
		// If dependencies exists, check if we need to rename edge_type to dependency_type
		var hasEdgeCol int
		_ = db.QueryRow("SELECT count(*) FROM pragma_table_info('dependencies') WHERE name='edge_type'").Scan(&hasEdgeCol)
		if hasEdgeCol > 0 {
			_, _ = db.Exec("ALTER TABLE dependencies RENAME COLUMN edge_type TO dependency_type")
		}
	}

	schema := `
	-- ─── Workspace ────────────────────────────────────────────────────────────
	-- One workspace = one Axiom project. Can span multiple code roots.
	CREATE TABLE IF NOT EXISTS workspaces (
		id          TEXT PRIMARY KEY,
		name        TEXT NOT NULL,
		opened_at   INTEGER NOT NULL
	);

	-- ─── Roots ────────────────────────────────────────────────────────────────
	-- A root is one filesystem directory that belongs to a workspace.
	-- A workspace can have multiple roots (backend + frontend + chrome-ext, etc.)
	CREATE TABLE IF NOT EXISTS roots (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		path          TEXT NOT NULL,
		branch        TEXT NOT NULL DEFAULT '',
		head_commit   TEXT NOT NULL DEFAULT '',
		is_primary   INTEGER NOT NULL DEFAULT 0,
		is_active    INTEGER NOT NULL DEFAULT 1,
		indexed_at    INTEGER,
		classifier_version INTEGER NOT NULL DEFAULT 0,
		ignored_paths_json TEXT NOT NULL DEFAULT '[]',
		source_boundaries_reviewed_at INTEGER
	);

	-- ─── Systems ──────────────────────────────────────────────────────────────
	-- Systems form a tree. parent_id = NULL means top-level.
	-- source tracks who created this system: semantic classifier, user, or agent.
	CREATE TABLE IF NOT EXISTS systems (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		name          TEXT NOT NULL,
		parent_id     TEXT REFERENCES systems(id) ON DELETE SET NULL,
		source        TEXT NOT NULL DEFAULT 'cluster',   -- 'cluster'|'user'|'agent'
		color         TEXT,
		description   TEXT,
		agent_notes   TEXT,
		depth         INTEGER NOT NULL DEFAULT 0,
		position_x    REAL NOT NULL DEFAULT 0,
		position_y    REAL NOT NULL DEFAULT 0,
		created_at    INTEGER NOT NULL,
		updated_at    INTEGER NOT NULL
	);

	-- ─── Files ────────────────────────────────────────────────────────────────
	-- One row per source file. system_id is the leaf system this file belongs to.
	-- A file is implicitly part of all ancestor systems via the systems tree.
	CREATE TABLE IF NOT EXISTS files (
		id            TEXT PRIMARY KEY,
		root_id       TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
		path          TEXT NOT NULL,                -- absolute path
		rel_path      TEXT NOT NULL,                -- relative to root
		language      TEXT NOT NULL DEFAULT 'unknown',
		system_id     TEXT REFERENCES systems(id) ON DELETE SET NULL,
		line_count    INTEGER NOT NULL DEFAULT 0,
		churn_score   REAL NOT NULL DEFAULT 0,
		position_x    REAL NOT NULL DEFAULT 0,
		position_y    REAL NOT NULL DEFAULT 0,
		indexed_at    INTEGER NOT NULL
	);
	CREATE UNIQUE INDEX IF NOT EXISTS files_root_path ON files(root_id, rel_path);

	-- ─── Symbols ──────────────────────────────────────────────────────────────
	-- Symbols are NOT canvas nodes. They live here to power the call graph.
	-- The canvas detail panel reads them; agents trace them via MCP.
	CREATE TABLE IF NOT EXISTS symbols (
		id            TEXT PRIMARY KEY,
		file_id       TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		name          TEXT NOT NULL,
		kind          TEXT NOT NULL,   -- 'function'|'class'|'interface'|'type'|'variable'|'method'
		line_start    INTEGER NOT NULL DEFAULT 0,
		line_end      INTEGER NOT NULL DEFAULT 0,
		body_hash     TEXT NOT NULL DEFAULT ''
	);
	CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file_id);

	-- ─── Dependencies ──────────────────────────────────────────────────────────
	-- All project dependencies: file→file imports, system→system, file→infra, etc.
	-- src_type / dst_type let us join to the right table without a union.
	CREATE TABLE IF NOT EXISTS dependencies (
		id               TEXT PRIMARY KEY,
		workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		src              TEXT NOT NULL,
		dst              TEXT NOT NULL,
		src_type         TEXT NOT NULL,   -- 'file'|'system'|'infra'
		dst_type         TEXT NOT NULL,
		dependency_type  TEXT NOT NULL,   -- 'IMPORTS'|'CALLS'|'DEPENDS_ON'|'READS_DB'|'CONTAINS'
		weight           INTEGER NOT NULL DEFAULT 1,
		created_by       TEXT NOT NULL DEFAULT 'parser'  -- 'parser'|'agent'|'user'
	);
	CREATE INDEX IF NOT EXISTS dependencies_src ON dependencies(src);
	CREATE INDEX IF NOT EXISTS dependencies_dst ON dependencies(dst);
	CREATE UNIQUE INDEX IF NOT EXISTS dependencies_unique ON dependencies(src, dst, dependency_type);

	-- ─── Call graph ───────────────────────────────────────────────────────────
	-- Symbol-level call graph. Separate table because it can have millions of rows.
	-- Used by agents for tracing; aggregated into edge weights for the canvas.
	CREATE TABLE IF NOT EXISTS call_graph (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		caller_file   TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		caller_symbol TEXT NOT NULL,
		callee_file   TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		callee_symbol TEXT NOT NULL,
		call_count    INTEGER NOT NULL DEFAULT 1
	);
	CREATE INDEX IF NOT EXISTS cg_caller ON call_graph(caller_file);
	CREATE INDEX IF NOT EXISTS cg_callee ON call_graph(callee_file);

	-- ─── Variable references (data-flow, Phase 7) ─────────────────────────────
	-- def/param/write rows are stored per-occurrence. 'read' rows are AGGREGATED
	-- to one row per (file, variable) with count — reads are ~80% of references
	-- and per-occurrence storage would explode the table. The data-flow API
	-- re-parses candidate files on demand for exact read lines (hybrid model).
	CREATE TABLE IF NOT EXISTS variable_refs (
		id               INTEGER PRIMARY KEY AUTOINCREMENT,
		file_id          TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		variable         TEXT NOT NULL,
		kind             TEXT NOT NULL,              -- 'def'|'param'|'write'|'read'
		line             INTEGER NOT NULL,           -- first line for aggregated reads
		count            INTEGER NOT NULL DEFAULT 1, -- >1 only for 'read' rows
		enclosing_symbol TEXT NOT NULL DEFAULT ''
	);
	CREATE INDEX IF NOT EXISTS varrefs_variable ON variable_refs(variable);
	CREATE INDEX IF NOT EXISTS varrefs_file ON variable_refs(file_id);

	-- ─── Investigation captures (Phase 8) ─────────────────────────────────────
	-- A recorded agent investigation: the full ordered event timeline serialized
	-- as JSON (the 'data' column is the AxiomTrace document), linked to the git
	-- commit it was captured against so replay renders the right code version.
	CREATE TABLE IF NOT EXISTS investigations (
		id            TEXT PRIMARY KEY,               -- short id (shareable)
		workspace_id  TEXT NOT NULL,
		name          TEXT NOT NULL DEFAULT '',
		commit_sha    TEXT NOT NULL DEFAULT '',
		branch        TEXT NOT NULL DEFAULT '',
		created_at    INTEGER NOT NULL,
		duration_ms   INTEGER NOT NULL DEFAULT 0,
		event_count   INTEGER NOT NULL DEFAULT 0,
		data          TEXT NOT NULL                   -- full AxiomTrace JSON
	);
	CREATE INDEX IF NOT EXISTS investigations_ws ON investigations(workspace_id);

	-- ─── File activity (live edit tracking) ──────────────────────────────────
	-- One row per edit BURST (saves within 5 min collapse). Powers the live
	-- churn/heat display and future time-lapse views. The current score is
	-- cached on files.activity_score with files.activity_at as decay anchor.
	CREATE TABLE IF NOT EXISTS file_activity (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		workspace_id  TEXT NOT NULL,
		file_id       TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		ts            INTEGER NOT NULL,               -- burst end, ms epoch
		actor         TEXT NOT NULL DEFAULT 'human',  -- 'human'|'agent'
		weight        REAL NOT NULL DEFAULT 0,        -- log10(1+dLines)+dSymbols, actor-scaled
		lines_delta   INTEGER NOT NULL DEFAULT 0,
		symbols_delta INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX IF NOT EXISTS file_activity_file ON file_activity(file_id, ts);
	CREATE INDEX IF NOT EXISTS file_activity_ws   ON file_activity(workspace_id, ts);

	-- ─── Sheets (UML experience layer — UML_UX_PLAN.md Phase U1) ─────────────
	-- A sheet is a named, curated diagram: a subset of live model elements,
	-- arranged by hand, annotated. Elements are REFERENCES, never copies.
	CREATE TABLE IF NOT EXISTS sheets (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		name          TEXT NOT NULL,
		purpose       TEXT,
		kind          TEXT NOT NULL DEFAULT 'structure',  -- 'structure'|'class'|'sequence'|'intent'
		folder        TEXT NOT NULL DEFAULT '',
		created_by    TEXT NOT NULL DEFAULT 'user',       -- 'user'|'agent'
		revision      INTEGER NOT NULL DEFAULT 1,
		viewport      TEXT,                               -- json {x,y,zoom}
		created_at    INTEGER NOT NULL,
		updated_at    INTEGER NOT NULL
	);

	-- Membership: concrete nullable FKs (exactly one set) instead of a
	-- polymorphic (type,id) pair — native integrity, no trigger web.
	-- ON DELETE SET NULL + the cached label IS the tombstone mechanism: ref
	-- gone but label present renders "payments/handler.go — deleted".
	CREATE TABLE IF NOT EXISTS sheet_elements (
		id            TEXT PRIMARY KEY,
		sheet_id      TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
		system_id     TEXT REFERENCES systems(id)     ON DELETE SET NULL,
		file_id       TEXT REFERENCES files(id)       ON DELETE SET NULL,
		infra_id      TEXT REFERENCES infra_nodes(id) ON DELETE SET NULL,
		symbol_ref    TEXT,             -- 'fileId::kind::name' (symbols lack stable ids)
		label         TEXT NOT NULL,    -- display snapshot cached at add time
		position_x    REAL NOT NULL DEFAULT 0,
		position_y    REAL NOT NULL DEFAULT 0,
		width         REAL,
		height        REAL,
		parent_system_id TEXT,
		emphasis      TEXT,             -- json {dim, accent, expandedToSymbols}
		design_metadata TEXT NOT NULL DEFAULT '{}', -- sheet-local authored design overlay for live entities
		tombstone_ack INTEGER NOT NULL DEFAULT 0,
		ghost         INTEGER NOT NULL DEFAULT 0,
		added_by      TEXT NOT NULL DEFAULT 'user',
		CHECK ((system_id IS NOT NULL) + (file_id IS NOT NULL) +
		       (infra_id IS NOT NULL) + (symbol_ref IS NOT NULL) = 1)
	);
	CREATE INDEX IF NOT EXISTS sheet_elements_sheet ON sheet_elements(sheet_id);

	-- Notes/flags: attachable to a sheet element or floating on a sheet;
	-- sheet_id NULL = model-global note. Agent replies to canvas messages
	-- land here too (threaded via canvas_outbox.answer_annotation_id).
	CREATE TABLE IF NOT EXISTS annotations (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL,
		sheet_id      TEXT REFERENCES sheets(id) ON DELETE CASCADE,
		target_type   TEXT,             -- 'system'|'file'|'infra'|NULL floating
		target_id     TEXT,
		body          TEXT NOT NULL,    -- markdown
		kind          TEXT NOT NULL DEFAULT 'note',  -- 'note'|'flag'|'decision'|'reply'
		author        TEXT NOT NULL DEFAULT 'user',  -- 'user'|'agent'
		position_x REAL, position_y REAL,
		created_at    INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS annotations_sheet ON annotations(sheet_id);

	-- Planned elements (UML_UX_PLAN.md REVISION 2): authored UML for code
	-- that does not exist yet. Lifecycle planned → partial → realized →
	-- flattened; the watcher reconciles declared paths/members against
	-- reality as the agent builds. Isolated from live tables by design.
	CREATE TABLE IF NOT EXISTS planned_nodes (
		id            TEXT PRIMARY KEY,
		sheet_id      TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
		workspace_id  TEXT NOT NULL,
		kind          TEXT NOT NULL DEFAULT 'class',   -- 'system'|'class'|'file'
		name          TEXT NOT NULL,
		declared_path TEXT NOT NULL DEFAULT '',        -- reconciliation hint (rel path)
		members       TEXT NOT NULL DEFAULT '[]',      -- json [{signature, intent, realized}]
		metadata      TEXT NOT NULL DEFAULT '{}',      -- versioned, kind-specific UML authoring metadata
		status        TEXT NOT NULL DEFAULT 'planned', -- 'planned'|'partial'|'realized'|'flattened'
		approval_status TEXT NOT NULL DEFAULT 'approved', -- 'pending'|'approved'|'rejected'
		realized_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
		notes         TEXT NOT NULL DEFAULT '',
		position_x    REAL NOT NULL DEFAULT 0,
		position_y    REAL NOT NULL DEFAULT 0,
		width         REAL,
		height        REAL,
		parent_system_id TEXT,
		created_by    TEXT NOT NULL DEFAULT 'user',
		created_at    INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS planned_nodes_sheet ON planned_nodes(sheet_id);
	CREATE INDEX IF NOT EXISTS planned_nodes_ws    ON planned_nodes(workspace_id, status);

	CREATE TABLE IF NOT EXISTS planned_edges (
		id           TEXT PRIMARY KEY,
		sheet_id     TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
		workspace_id TEXT NOT NULL,
		kind         TEXT NOT NULL DEFAULT 'DEPENDS_ON', -- 'CALLS'|'DEPENDS_ON'|'CONTAINS'
		src_planned  TEXT REFERENCES planned_nodes(id) ON DELETE CASCADE,
		src_live     TEXT,   -- live node id (file/system/infra) when src is real
		dst_planned  TEXT REFERENCES planned_nodes(id) ON DELETE CASCADE,
		dst_live     TEXT,
		note         TEXT NOT NULL DEFAULT ''
	);
	CREATE INDEX IF NOT EXISTS planned_edges_sheet ON planned_edges(sheet_id);

	-- Canvas→agent outbox (UML_UX_PLAN.md Phase U-C). The user composes a
	-- note on the canvas; MCP tools drain it; every axiom tool response
	-- carries an unread-count trailer so any active agent sees it fast.
	CREATE TABLE IF NOT EXISTS canvas_outbox (
		id             TEXT PRIMARY KEY,
		workspace_id   TEXT NOT NULL,
		sheet_id       TEXT,
		note           TEXT NOT NULL,
		selection      TEXT NOT NULL DEFAULT '[]',  -- json durable refs
		change_summary TEXT NOT NULL DEFAULT '',    -- 12-verb semantic summary
		sheet_context  TEXT NOT NULL DEFAULT '',    -- immutable JSON snapshot resolved against the live Floor
		build_spec     TEXT NOT NULL DEFAULT '',    -- approved planned increment at send time
		status         TEXT NOT NULL DEFAULT 'queued', -- 'queued'|'delivered'|'answered'
		delivered_to   TEXT,
		answer_annotation_id TEXT,
		created_at INTEGER NOT NULL, delivered_at INTEGER, answered_at INTEGER
	);
	CREATE INDEX IF NOT EXISTS canvas_outbox_ws ON canvas_outbox(workspace_id, status);

	-- ─── Infra nodes ──────────────────────────────────────────────────────────
	-- External dependencies (databases, queues, APIs, platforms) as first-class
	-- canvas nodes. See INFRA_LAYER_PLAN.md. Identity is Category x Provider x
	-- Service: category drives edge semantics + node silhouette, provider drives
	-- the brand skin, service is the registry id ('aws/rds', 'openai/api', ...).
	CREATE TABLE IF NOT EXISTS infra_nodes (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		name          TEXT NOT NULL,
		infra_type    TEXT NOT NULL DEFAULT 'custom',  -- DEPRECATED: superseded by category/provider/service
		category      TEXT NOT NULL DEFAULT 'api',     -- 'database'|'cache'|'queue'|'storage'|'search'|'llm'|'api'|'auth'|'platform'|'cdn'|'observability'|'email'
		provider      TEXT NOT NULL DEFAULT 'generic', -- 'aws'|'openai'|'stripe'|'generic'|...
		service       TEXT NOT NULL DEFAULT '',        -- registry id, e.g. 'aws/rds'; '' = unassigned generic
		subtype       TEXT NOT NULL DEFAULT '',        -- category-specific ('sql'|'document'|'kv'|'vector'|...)
		status        TEXT NOT NULL DEFAULT 'confirmed', -- 'proposed'|'confirmed'|'dismissed'
		detected_by   TEXT,                            -- json evidence [{signal, file, evidence, confidence}]
		config        TEXT,                             -- json blob (registry configFields values)
		position_x    REAL NOT NULL DEFAULT 0,
		position_y    REAL NOT NULL DEFAULT 0
	);

	-- ─── Structural journal (Morning Delta) ──────────────────────────────────
	-- Durable record of how the architecture changed, so a delta survives the
	-- app being closed. Deliberately denormalized: a row must outlive the file
	-- it describes, so it carries labels and holds no foreign keys.
	CREATE TABLE IF NOT EXISTS structural_events (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		workspace_id  TEXT NOT NULL,
		root_id       TEXT,
		branch        TEXT,
		ts            INTEGER NOT NULL,               -- ms epoch
		actor         TEXT NOT NULL DEFAULT 'human',  -- 'human'|'agent'
		trace_id      TEXT NOT NULL DEFAULT '',       -- correlates one save's events
		kind          TEXT NOT NULL,
		subject_id    TEXT NOT NULL DEFAULT '',
		subject_label TEXT NOT NULL DEFAULT '',
		object_id     TEXT NOT NULL DEFAULT '',
		object_label  TEXT NOT NULL DEFAULT '',
		detail        TEXT NOT NULL DEFAULT '',       -- kind-specific JSON
		count         INTEGER NOT NULL DEFAULT 1      -- collapsed repeat saves
	);
	CREATE INDEX IF NOT EXISTS structural_events_ws ON structural_events(workspace_id, ts);
	-- Exact system-graph snapshots at delta read boundaries. Keeping the
	-- snapshot keyed by the returned until timestamp lets a later ack persist
	-- the precise graph the user reviewed, even if more work landed meanwhile.
	CREATE TABLE IF NOT EXISTS delta_snapshots (
		workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		at           INTEGER NOT NULL,
		snapshot     TEXT NOT NULL,
		PRIMARY KEY(workspace_id, at)
	);
	CREATE INDEX IF NOT EXISTS delta_snapshots_ws ON delta_snapshots(workspace_id, at);

	-- An agent's own account of what it set out to do. Structural facts are
	-- true but thin; narration is how the agent writes intent INTO the map so
	-- a delta reads as work rather than as topology.
	CREATE TABLE IF NOT EXISTS work_sessions (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL,
		root_id       TEXT,
		branch        TEXT,
		owner_key     TEXT NOT NULL DEFAULT '',
		agent         TEXT NOT NULL DEFAULT '',
		goal          TEXT NOT NULL,
		summary       TEXT NOT NULL DEFAULT '',
		notes         TEXT NOT NULL DEFAULT '[]',   -- JSON [{ts,text}]
		focus_system_ids TEXT NOT NULL DEFAULT '[]',
		focus_file_ids   TEXT NOT NULL DEFAULT '[]',
		started_at    INTEGER NOT NULL,
		ended_at      INTEGER NOT NULL DEFAULT 0    -- 0 = still open
	);
	CREATE INDEX IF NOT EXISTS work_sessions_ws ON work_sessions(workspace_id, started_at);

	-- Everything an agent DOES, including reads. The structural journal only
	-- records changes to the architecture; this records activity, because
	-- watching an agent trace a call path is the point of a living canvas even
	-- though tracing changes nothing.
	CREATE TABLE IF NOT EXISTS agent_actions (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		workspace_id  TEXT NOT NULL,
		root_id       TEXT,
		branch        TEXT,
		ts            INTEGER NOT NULL,
		session_id    TEXT NOT NULL DEFAULT '',
		agent         TEXT NOT NULL DEFAULT '',
		tool          TEXT NOT NULL,
		kind          TEXT NOT NULL,            -- read|trace|write|plan|debug|narrate
		summary       TEXT NOT NULL DEFAULT '',
		targets       TEXT NOT NULL DEFAULT '[]', -- JSON canvas node IDs
		detail        TEXT NOT NULL DEFAULT '',   -- JSON, tool-specific
		duration_ms   INTEGER NOT NULL DEFAULT 0,
		status        TEXT NOT NULL DEFAULT 'ok',
		error         TEXT NOT NULL DEFAULT ''
	);
	CREATE INDEX IF NOT EXISTS agent_actions_ws ON agent_actions(workspace_id, ts);

	-- Floor geometry is deliberately separate from semantic ownership. A file's
	-- system_id and a system's parent_id describe the live codebase; layout_parent
	-- describes the coordinate frame it is visually placed in (including hosting).
	CREATE TABLE IF NOT EXISTS floor_layouts (
		workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		node_id           TEXT NOT NULL,
		node_type         TEXT NOT NULL CHECK(node_type IN ('system','file','infra')),
		parent_node_id    TEXT,
		parent_node_type  TEXT CHECK(parent_node_type IS NULL OR parent_node_type IN ('system','infra')),
		containment_kind  TEXT NOT NULL DEFAULT 'root' CHECK(containment_kind IN ('root','part_of','hosted_by')),
		position_x        REAL NOT NULL DEFAULT 0,
		position_y        REAL NOT NULL DEFAULT 0,
		width             REAL NOT NULL,
		height            REAL NOT NULL,
		scale             REAL NOT NULL DEFAULT 1 CHECK(scale > 0),
		-- How much this frame shrinks its CONTENTS, independent of its own size.
		-- scale answers "how big am I in my parent"; interior_scale answers
		-- "how big is everything inside me". Keeping them separate is what lets a
		-- crowded frame compress its interior without its own chrome reacting.
		interior_scale    REAL NOT NULL DEFAULT 1 CHECK(interior_scale > 0),
		updated_at        INTEGER NOT NULL,
		PRIMARY KEY(workspace_id, node_type, node_id)
	);
	CREATE INDEX IF NOT EXISTS floor_layouts_parent
		ON floor_layouts(workspace_id, parent_node_type, parent_node_id);
	CREATE TABLE IF NOT EXISTS floor_layout_revisions (
		workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
		revision INTEGER NOT NULL DEFAULT 0
	);
	-- Sheet geometry uses the exact same spatial algebra as the Floor while
	-- remaining proposal-local. Membership/intent stays in sheet_elements and
	-- planned_nodes; this table owns geometry only.
	CREATE TABLE IF NOT EXISTS sheet_layouts (
		sheet_id           TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
		workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		node_id            TEXT NOT NULL,
		node_type          TEXT NOT NULL CHECK(node_type IN ('system','file','infra')),
		parent_node_id     TEXT,
		parent_node_type   TEXT CHECK(parent_node_type IS NULL OR parent_node_type IN ('system','infra')),
		containment_kind   TEXT NOT NULL DEFAULT 'root' CHECK(containment_kind IN ('root','part_of','hosted_by')),
		position_x         REAL NOT NULL DEFAULT 0,
		position_y         REAL NOT NULL DEFAULT 0,
		width              REAL NOT NULL,
		height             REAL NOT NULL,
		scale              REAL NOT NULL DEFAULT 1 CHECK(scale > 0),
		interior_scale     REAL NOT NULL DEFAULT 1 CHECK(interior_scale > 0),
		updated_at         INTEGER NOT NULL,
		PRIMARY KEY(sheet_id, node_id)
	);
	CREATE INDEX IF NOT EXISTS sheet_layouts_parent
		ON sheet_layouts(sheet_id, parent_node_type, parent_node_id);
	CREATE TRIGGER IF NOT EXISTS floor_layout_cleanup_system AFTER DELETE ON systems BEGIN
		DELETE FROM floor_layouts WHERE node_type='system' AND node_id=OLD.id;
		UPDATE floor_layouts SET parent_node_id=NULL, parent_node_type=NULL, containment_kind='root'
			WHERE parent_node_type='system' AND parent_node_id=OLD.id;
	END;
	CREATE TRIGGER IF NOT EXISTS floor_layout_cleanup_file AFTER DELETE ON files BEGIN
		DELETE FROM floor_layouts WHERE node_type='file' AND node_id=OLD.id;
	END;
	CREATE TRIGGER IF NOT EXISTS floor_layout_cleanup_infra AFTER DELETE ON infra_nodes BEGIN
		DELETE FROM floor_layouts WHERE node_type='infra' AND node_id=OLD.id;
		UPDATE floor_layouts SET parent_node_id=NULL, parent_node_type=NULL, containment_kind='root'
			WHERE parent_node_type='infra' AND parent_node_id=OLD.id;
	END;
	CREATE TRIGGER IF NOT EXISTS sheet_layout_cleanup_system AFTER DELETE ON systems BEGIN
		DELETE FROM sheet_layouts WHERE node_type='system' AND node_id=OLD.id;
		UPDATE sheet_layouts SET parent_node_id=NULL, parent_node_type=NULL, containment_kind='root'
			WHERE parent_node_type='system' AND parent_node_id=OLD.id;
	END;
	CREATE TRIGGER IF NOT EXISTS sheet_layout_cleanup_file AFTER DELETE ON files BEGIN
		DELETE FROM sheet_layouts WHERE node_type='file' AND node_id=OLD.id;
	END;
	CREATE TRIGGER IF NOT EXISTS sheet_layout_cleanup_infra AFTER DELETE ON infra_nodes BEGIN
		DELETE FROM sheet_layouts WHERE node_type='infra' AND node_id=OLD.id;
		UPDATE sheet_layouts SET parent_node_id=NULL, parent_node_type=NULL, containment_kind='root'
			WHERE parent_node_type='infra' AND parent_node_id=OLD.id;
	END;
	`

	if _, err := db.Exec(schema); err != nil {
		return err
	}

	// Preserve Floor containment when the sheet override column is first added
	// to an existing database. On later starts the duplicate-column result skips
	// this backfill, so an intentional NULL (sheet-root placement) stays NULL.
	if _, err := db.Exec(`ALTER TABLE sheet_elements ADD COLUMN parent_system_id TEXT`); err == nil {
		if _, err := db.Exec(`
			UPDATE sheet_elements
			SET parent_system_id = CASE
				WHEN file_id IS NOT NULL THEN (SELECT system_id FROM files WHERE files.id = sheet_elements.file_id)
				WHEN system_id IS NOT NULL THEN (SELECT parent_id FROM systems WHERE systems.id = sheet_elements.system_id)
				ELSE NULL
			END`); err != nil {
			return fmt.Errorf("backfill sheet containment: %w", err)
		}
	} else if !strings.Contains(err.Error(), "duplicate column name") {
		return fmt.Errorf("migration: sheet parent override: %w", err)
	}

	// Additive column migrations — SQLite has no IF NOT EXISTS for columns;
	// we attempt each ALTER and ignore "duplicate column name" errors.
	for _, col := range []string{
		`ALTER TABLE systems ADD COLUMN width  REAL`,
		`ALTER TABLE systems ADD COLUMN height REAL`,
		`ALTER TABLE files   ADD COLUMN width  REAL`,
		`ALTER TABLE files   ADD COLUMN height REAL`,
		// Unified shape vocabulary (UML_UX_PLAN.md Rev 2b): shape is a SEMANTIC
		// role inferred at index time ('', 'class', 'cylinder', 'hexagon');
		// display_name is the class-first title (dominant class ≈ filename);
		// shape_override wins over inference when the user/agent sets it.
		`ALTER TABLE files ADD COLUMN shape          TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE files ADD COLUMN shape_override TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE files ADD COLUMN display_name   TEXT NOT NULL DEFAULT ''`,
		// Morning Delta watermark: the moment the user last acknowledged the
		// structural journal. Zero means never reviewed.
		`ALTER TABLE workspaces ADD COLUMN delta_reviewed_at INTEGER NOT NULL DEFAULT 0`,
		// Links a structural change to the work an agent declared it was doing.
		`ALTER TABLE structural_events ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`,
		// Work-session ownership allows independent MCP clients to narrate work
		// concurrently. Focus is the durable scope used for honest attribution
		// and for live presence on the canvas.
		`ALTER TABLE work_sessions ADD COLUMN owner_key TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE work_sessions ADD COLUMN focus_system_ids TEXT NOT NULL DEFAULT '[]'`,
		`ALTER TABLE work_sessions ADD COLUMN focus_file_ids TEXT NOT NULL DEFAULT '[]'`,
		// Live activity tracking (edit bursts, decayed scores)
		`ALTER TABLE files ADD COLUMN activity_score REAL    NOT NULL DEFAULT 0`,
		`ALTER TABLE files ADD COLUMN activity_at    INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE files ADD COLUMN content_hash   TEXT    NOT NULL DEFAULT ''`,
		// Per-symbol content identity lets live relationship choreography
		// distinguish a connected function edit from an unrelated file write.
		`ALTER TABLE symbols ADD COLUMN body_hash TEXT NOT NULL DEFAULT ''`,
		// Classifier contract version. A bump triggers a one-time semantic
		// reclassification without reparsing source files.
		`ALTER TABLE roots ADD COLUMN classifier_version INTEGER NOT NULL DEFAULT 0`,
		// Source-boundary decisions are first-class persisted project state.
		// An empty JSON array is a valid completed "include everything" choice.
		`ALTER TABLE roots ADD COLUMN ignored_paths_json TEXT NOT NULL DEFAULT '[]'`,
		`ALTER TABLE roots ADD COLUMN source_boundaries_reviewed_at INTEGER`,
		// Git worktrees are live roots. Existing roots stay active by default and
		// are identified as primary on the next workspace reconciliation.
		`ALTER TABLE roots ADD COLUMN branch TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE roots ADD COLUMN head_commit TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE roots ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE roots ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`,
		// Parallel-agent history is stamped at write time. NULL deliberately
		// remains the legacy representation and resolves to the primary root.
		`ALTER TABLE structural_events ADD COLUMN root_id TEXT`,
		`ALTER TABLE structural_events ADD COLUMN branch TEXT`,
		`ALTER TABLE work_sessions ADD COLUMN root_id TEXT`,
		`ALTER TABLE work_sessions ADD COLUMN branch TEXT`,
		`ALTER TABLE agent_actions ADD COLUMN root_id TEXT`,
		`ALTER TABLE agent_actions ADD COLUMN branch TEXT`,
		// Planned UML authoring: semantic shape + user color (REVISION 2 UX)
		`ALTER TABLE planned_nodes ADD COLUMN shape TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE planned_nodes ADD COLUMN color TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE planned_nodes ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`,
		`ALTER TABLE planned_nodes ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'`,
		// Sheet-local containment for planned elements.
		`ALTER TABLE planned_nodes ADD COLUMN parent_system_id TEXT`,
		`ALTER TABLE planned_nodes ADD COLUMN width REAL`,
		`ALTER TABLE planned_nodes ADD COLUMN height REAL`,
		`ALTER TABLE planned_nodes ADD COLUMN scale REAL NOT NULL DEFAULT 1`,
		`ALTER TABLE canvas_outbox ADD COLUMN sheet_context TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE canvas_outbox ADD COLUMN build_spec TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE sheet_elements ADD COLUMN design_metadata TEXT NOT NULL DEFAULT '{}'`,
		`ALTER TABLE sheet_elements ADD COLUMN scale REAL NOT NULL DEFAULT 1`,
		// Migrate the original shape-overloaded stencil kinds to explicit semantics.
		`UPDATE planned_nodes SET kind='data_store' WHERE kind='class' AND shape='cylinder'`,
		`UPDATE planned_nodes SET kind='service' WHERE kind='class' AND shape='hexagon'`,
		// Infra layer (INFRA_LAYER_PLAN.md Phase I1)
		`ALTER TABLE infra_nodes  ADD COLUMN category    TEXT NOT NULL DEFAULT 'api'`,
		`ALTER TABLE infra_nodes  ADD COLUMN provider    TEXT NOT NULL DEFAULT 'generic'`,
		`ALTER TABLE infra_nodes  ADD COLUMN service     TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE infra_nodes  ADD COLUMN subtype     TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE infra_nodes  ADD COLUMN status      TEXT NOT NULL DEFAULT 'confirmed'`,
		`ALTER TABLE infra_nodes  ADD COLUMN detected_by TEXT`,
		`ALTER TABLE dependencies ADD COLUMN evidence    TEXT`,
		// Interior compression is a distinct property from a frame's own scale.
		// Existing rows default to 1, which is exactly "does not compress".
		`ALTER TABLE floor_layouts ADD COLUMN interior_scale REAL NOT NULL DEFAULT 1`,
	} {
		if _, err := db.Exec(col); err != nil {
			// "duplicate column name" means the column already exists — safe to ignore
			if !strings.Contains(err.Error(), "duplicate column name") {
				return fmt.Errorf("migration: %s: %w", col, err)
			}
		}
	}
	if err := BackfillSheetLayouts(db); err != nil {
		return err
	}
	if _, err := db.Exec(`
		CREATE INDEX IF NOT EXISTS structural_events_root ON structural_events(workspace_id, root_id, ts);
		CREATE INDEX IF NOT EXISTS work_sessions_root ON work_sessions(workspace_id, root_id, started_at);
		CREATE INDEX IF NOT EXISTS agent_actions_root ON agent_actions(workspace_id, root_id, ts);
	`); err != nil {
		return fmt.Errorf("create branch-history indexes: %w", err)
	}

	// 2026-07: filename-based cylinder/hexagon shape guessing was removed
	// (shape now derives only from proven structure). Purge stale guesses;
	// explicit user/agent choices live in shape_override and are untouched.
	if _, err := db.Exec(`UPDATE files SET shape='' WHERE shape IN ('cylinder','hexagon')`); err != nil {
		return fmt.Errorf("purge guessed shapes: %w", err)
	}

	// The classification job workflow was removed 2026-07 (superseded by the
	// indexer's clustering + the start_review agent flow). Drop its tables.
	if _, err := db.Exec(`
		DROP TABLE IF EXISTS classification_assignments;
		DROP TABLE IF EXISTS classification_jobs`); err != nil {
		return fmt.Errorf("drop classification tables: %w", err)
	}

	// Referential-integrity triggers: `dependencies` is polymorphic (src/dst +
	// type columns), so SQLite cannot enforce foreign keys across it. Without
	// these, deleting a file/system/infra node strands its edges forever.
	if _, err := db.Exec(`
		CREATE TRIGGER IF NOT EXISTS deps_cleanup_on_file_delete
		AFTER DELETE ON files BEGIN
			DELETE FROM dependencies
			WHERE (src = OLD.id AND src_type = 'file') OR (dst = OLD.id AND dst_type = 'file');
		END;
		CREATE TRIGGER IF NOT EXISTS deps_cleanup_on_system_delete
		AFTER DELETE ON systems BEGIN
			DELETE FROM dependencies
			WHERE (src = OLD.id AND src_type = 'system') OR (dst = OLD.id AND dst_type = 'system');
		END;
		CREATE TRIGGER IF NOT EXISTS deps_cleanup_on_infra_delete
		AFTER DELETE ON infra_nodes BEGIN
			DELETE FROM dependencies
			WHERE (src = OLD.id AND src_type = 'infra') OR (dst = OLD.id AND dst_type = 'infra');
		END`); err != nil {
		return fmt.Errorf("create integrity triggers: %w", err)
	}

	// One-time sweep of edges already orphaned before the triggers existed.
	if _, err := db.Exec(`
		DELETE FROM dependencies WHERE
			(src_type='file'   AND src NOT IN (SELECT id FROM files))    OR
			(dst_type='file'   AND dst NOT IN (SELECT id FROM files))    OR
			(src_type='system' AND src NOT IN (SELECT id FROM systems))  OR
			(dst_type='system' AND dst NOT IN (SELECT id FROM systems))  OR
			(src_type='infra'  AND src NOT IN (SELECT id FROM infra_nodes)) OR
			(dst_type='infra'  AND dst NOT IN (SELECT id FROM infra_nodes))`); err != nil {
		return fmt.Errorf("orphaned dependency sweep: %w", err)
	}

	_, err = db.Exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS systems_unique_name
			ON systems(workspace_id, COALESCE(parent_id, ''), name)`)
	return err
}
