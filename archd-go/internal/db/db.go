// Package db manages the SQLite database that is archd's single source of truth.
// Every system assignment, file record, edge, and classification job lives here.
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

// Open creates (or opens) the SQLite database at the given path and runs
// all schema migrations. Returns a ready-to-use *sql.DB.
func Open(dataDir string) (*sql.DB, error) {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	dbPath := filepath.Join(dataDir, "axiom.db")
	db, err := sql.Open("sqlite3", dbPath+"?_foreign_keys=on&_journal_mode=WAL&_synchronous=NORMAL")
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	db.SetMaxOpenConns(1) // SQLite is not safe for concurrent writes

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
		indexed_at    INTEGER
	);

	-- ─── Systems ──────────────────────────────────────────────────────────────
	-- Systems form a tree. parent_id = NULL means top-level.
	-- source tracks who created this system: directory auto-grouping, user, or agent.
	CREATE TABLE IF NOT EXISTS systems (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		name          TEXT NOT NULL,
		parent_id     TEXT REFERENCES systems(id) ON DELETE SET NULL,
		source        TEXT NOT NULL DEFAULT 'directory',   -- 'directory'|'user'|'agent'
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
		line_end      INTEGER NOT NULL DEFAULT 0
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

	-- ─── Infra nodes ──────────────────────────────────────────────────────────
	CREATE TABLE IF NOT EXISTS infra_nodes (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		name          TEXT NOT NULL,
		infra_type    TEXT NOT NULL DEFAULT 'custom',  -- 'postgres'|'redis'|'vercel'|'railway'|...
		config        TEXT,                             -- json blob
		position_x    REAL NOT NULL DEFAULT 0,
		position_y    REAL NOT NULL DEFAULT 0
	);

	-- ─── Classification jobs ──────────────────────────────────────────────────
	-- Tracks agent-driven system organization runs.
	CREATE TABLE IF NOT EXISTS classification_jobs (
		id                  TEXT PRIMARY KEY,
		workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		status              TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'running'|'paused'|'complete'
		total_files         INTEGER NOT NULL DEFAULT 0,
		classified_files    INTEGER NOT NULL DEFAULT 0,
		strategy            TEXT NOT NULL DEFAULT 'by_import_cluster',
		created_at          INTEGER NOT NULL,
		completed_at        INTEGER
	);

	-- Per-file proposals from the agent during a classification job
	CREATE TABLE IF NOT EXISTS classification_assignments (
		id                  INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id              TEXT NOT NULL REFERENCES classification_jobs(id) ON DELETE CASCADE,
		file_id             TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		proposed_system     TEXT NOT NULL,
		parent_system       TEXT,
		confidence          REAL NOT NULL DEFAULT 0,
		agent_reasoning     TEXT,
		status              TEXT NOT NULL DEFAULT 'pending'  -- 'pending'|'accepted'|'rejected'|'modified'
	);
	`

	if _, err := db.Exec(schema); err != nil {
		return err
	}

	// Additive column migrations — SQLite has no IF NOT EXISTS for columns;
	// we attempt each ALTER and ignore "duplicate column name" errors.
	for _, col := range []string{
		`ALTER TABLE systems ADD COLUMN width  REAL`,
		`ALTER TABLE systems ADD COLUMN height REAL`,
		`ALTER TABLE files   ADD COLUMN width  REAL`,
		`ALTER TABLE files   ADD COLUMN height REAL`,
	} {
		if _, err := db.Exec(col); err != nil {
			// "duplicate column name" means the column already exists — safe to ignore
			if !strings.Contains(err.Error(), "duplicate column name") {
				return fmt.Errorf("migration: %s: %w", col, err)
			}
		}
	}

	// Disable FK enforcement while wiping systems so that the ON DELETE SET NULL
	// cascade on systems.parent_id doesn't fire and violate the unique index on rows
	// that are about to be deleted anyway.
	if _, err := db.Exec(`PRAGMA foreign_keys = OFF`); err != nil {
		return err
	}
	if _, err := db.Exec(`DELETE FROM systems`); err != nil {
		return err
	}
	if _, err := db.Exec(`PRAGMA foreign_keys = ON`); err != nil {
		return err
	}

	_, err = db.Exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS systems_unique_name
			ON systems(workspace_id, COALESCE(parent_id, ''), name)`)
	return err
}
