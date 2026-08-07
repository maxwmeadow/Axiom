package db

import (
	"context"
	"fmt"
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
