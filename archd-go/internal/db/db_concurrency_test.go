package db

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestOpenKeepsReadsResponsiveDuringWriteTransaction(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	if err := UpsertWorkspace(sqlDB, Workspace{ID: "existing", Name: "existing"}); err != nil {
		t.Fatal(err)
	}

	tx, err := sqlDB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.Exec(`INSERT INTO workspaces (id, name, opened_at) VALUES ('pending', 'pending', 0)`); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	var count int
	if err := sqlDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspaces`).Scan(&count); err != nil {
		t.Fatalf("read stalled behind an unrelated writer: %v", err)
	}
	if count != 1 {
		t.Fatalf("reader observed %d committed workspaces, want 1", count)
	}
}

func TestOpenSerializesParallelWritersWithoutLockFailures(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	if _, err := sqlDB.Exec(`
		CREATE TABLE concurrent_write_probe (
			writer INTEGER NOT NULL,
			sequence INTEGER NOT NULL,
			PRIMARY KEY (writer, sequence)
		)`); err != nil {
		t.Fatal(err)
	}

	const writers = 8
	const writesPerWorker = 20
	start := make(chan struct{})
	errs := make(chan error, writers)
	var wg sync.WaitGroup
	for writer := 0; writer < writers; writer++ {
		writer := writer
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for sequence := 0; sequence < writesPerWorker; sequence++ {
				if _, err := sqlDB.Exec(
					`INSERT INTO concurrent_write_probe (writer, sequence) VALUES (?, ?)`,
					writer,
					sequence,
				); err != nil {
					errs <- fmt.Errorf("writer %d sequence %d: %w", writer, sequence, err)
					return
				}
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if t.Failed() {
		return
	}

	var count int
	if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM concurrent_write_probe`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	want := writers * writesPerWorker
	if count != want {
		t.Fatalf("persisted rows = %d, want %d", count, want)
	}
}

func TestOpenPreservesIndexedWorkspaceAtLegacyDatabasePath(t *testing.T) {
	dataDir := t.TempDir()
	first, err := Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := UpsertWorkspace(first, Workspace{ID: "ws", Name: "existing"}); err != nil {
		t.Fatal(err)
	}
	root := Root{ID: "root", WorkspaceID: "ws", Path: "C:/existing-project"}
	if err := UpsertRoot(first, root); err != nil {
		t.Fatal(err)
	}
	if err := MarkRootIndexed(first, root.ID, 3); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	roots, err := GetRoots(reopened, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 1 || roots[0].IndexedAt == nil || *roots[0].IndexedAt == 0 {
		t.Fatalf("reopened root lost its indexed state: %#v", roots)
	}
}

func TestOpenAddsWorktreeMetadataToLegacyRootWithoutReindex(t *testing.T) {
	dataDir := t.TempDir()
	legacy, err := sql.Open("sqlite3", filepath.Join(dataDir, "axiom.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(`
		CREATE TABLE workspaces (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			opened_at INTEGER NOT NULL,
			delta_reviewed_at INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE roots (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
			path TEXT NOT NULL,
			indexed_at INTEGER,
			classifier_version INTEGER NOT NULL DEFAULT 0,
			ignored_paths_json TEXT NOT NULL DEFAULT '[]',
			source_boundaries_reviewed_at INTEGER
		);
		CREATE TABLE structural_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			workspace_id TEXT NOT NULL,
			ts INTEGER NOT NULL,
			actor TEXT NOT NULL DEFAULT 'human',
			trace_id TEXT NOT NULL DEFAULT '',
			kind TEXT NOT NULL,
			subject_id TEXT NOT NULL DEFAULT '',
			subject_label TEXT NOT NULL DEFAULT '',
			object_id TEXT NOT NULL DEFAULT '',
			object_label TEXT NOT NULL DEFAULT '',
			detail TEXT NOT NULL DEFAULT '',
			count INTEGER NOT NULL DEFAULT 1,
			session_id TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE work_sessions (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			owner_key TEXT NOT NULL DEFAULT '',
			agent TEXT NOT NULL DEFAULT '',
			goal TEXT NOT NULL,
			summary TEXT NOT NULL DEFAULT '',
			notes TEXT NOT NULL DEFAULT '[]',
			focus_system_ids TEXT NOT NULL DEFAULT '[]',
			focus_file_ids TEXT NOT NULL DEFAULT '[]',
			started_at INTEGER NOT NULL,
			ended_at INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE agent_actions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			workspace_id TEXT NOT NULL,
			ts INTEGER NOT NULL,
			session_id TEXT NOT NULL DEFAULT '',
			agent TEXT NOT NULL DEFAULT '',
			tool TEXT NOT NULL,
			kind TEXT NOT NULL,
			summary TEXT NOT NULL DEFAULT '',
			targets TEXT NOT NULL DEFAULT '[]',
			detail TEXT NOT NULL DEFAULT '',
			duration_ms INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'ok',
			error TEXT NOT NULL DEFAULT ''
		);
		INSERT INTO workspaces (id, name, opened_at, delta_reviewed_at)
		VALUES ('ws', 'legacy', 1, 321);
		INSERT INTO roots (
			id, workspace_id, path, indexed_at, classifier_version,
			ignored_paths_json, source_boundaries_reviewed_at
		) VALUES ('root', 'ws', 'C:/legacy', 123, 3, '[]', NULL);
		INSERT INTO structural_events (workspace_id, ts, kind) VALUES ('ws', 10, 'file.updated');
		INSERT INTO work_sessions (id, workspace_id, goal, started_at) VALUES ('session', 'ws', 'legacy work', 10);
		INSERT INTO agent_actions (workspace_id, ts, tool, kind) VALUES ('ws', 10, 'query', 'read');
	`); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	migrated, err := Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = migrated.Close() })
	roots, err := GetRoots(migrated, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 1 || roots[0].IndexedAt == nil || *roots[0].IndexedAt != 123 || !roots[0].IsActive {
		t.Fatalf("legacy root migration = %#v", roots)
	}
	reviewedAt, err := GetDeltaReviewedAtForRoot(migrated, "ws", "root")
	if err != nil || reviewedAt != 321 {
		t.Fatalf("legacy primary watermark = %d, err = %v", reviewedAt, err)
	}
	events, err := GetStructuralEvents(migrated, "ws", 0)
	if err != nil || len(events) != 1 || events[0].RootID != "root" || events[0].Branch != "" {
		t.Fatalf("legacy event identity = %#v, err = %v", events, err)
	}
	sessions, err := GetWorkSessions(migrated, "ws", 0)
	if err != nil || len(sessions) != 1 || sessions[0].RootID != "root" || sessions[0].Branch != "" {
		t.Fatalf("legacy session identity = %#v, err = %v", sessions, err)
	}
	actions, err := GetAgentActions(migrated, "ws", 0, 10)
	if err != nil || len(actions) != 1 || actions[0].RootID != "root" || actions[0].Branch != "" {
		t.Fatalf("legacy action identity = %#v, err = %v", actions, err)
	}
}
