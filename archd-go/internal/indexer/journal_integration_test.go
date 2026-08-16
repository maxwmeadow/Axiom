package indexer

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/delta"
	"axiom.local/archd/internal/hub"
)

// The journal is what makes the delta survive the app being closed, so these
// tests exercise the real reindex path rather than the pure aggregator.

func journalFixture(t *testing.T) (*sql.DB, db.Root, *hub.Hub) {
	t.Helper()
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	root := db.Root{
		ID: "root", WorkspaceID: "ws", Path: t.TempDir(),
		Branch: "feature/journal", IsPrimary: true,
	}
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "journal"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	return sqlDB, root, hub.New()
}

// reviewedAt returns a watermark positioned strictly between the events
// recorded so far and everything that happens next. The journal is
// millisecond-resolution and the delta window is exclusive (ts > since), so a
// test that acts within the same millisecond as its own setup would otherwise
// filter out the change it is asserting on.
func reviewedAt(t *testing.T, sqlDB *sql.DB) int64 {
	t.Helper()
	events, err := db.GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	watermark := int64(0)
	if len(events) > 0 {
		watermark = events[len(events)-1].TS
	}
	for time.Now().UnixMilli() <= watermark {
		time.Sleep(time.Millisecond)
	}
	return watermark
}

func journalSummary(t *testing.T, sqlDB *sql.DB, since int64) delta.Summary {
	t.Helper()
	events, err := db.GetStructuralEvents(sqlDB, "ws", since)
	if err != nil {
		t.Fatal(err)
	}
	return delta.Aggregate(events, since, 0)
}

func TestReindexJournalsCreationAndTopology(t *testing.T) {
	sqlDB, root, eventHub := journalFixture(t)

	callerPath := filepath.Join(root.Path, "caller.py")
	calleePath := filepath.Join(root.Path, "worker.py")
	writeLivingFixture(t, calleePath, "def transform(value):\n    return value + 1\n")
	if err := ReindexFile(sqlDB, eventHub, root, calleePath); err != nil {
		t.Fatal(err)
	}
	writeLivingFixture(t, callerPath, "from worker import transform\n\ndef run(value):\n    return transform(value)\n")
	if err := ReindexFile(sqlDB, eventHub, root, callerPath); err != nil {
		t.Fatal(err)
	}

	summary := journalSummary(t, sqlDB, 0)
	if summary.Counts.FilesCreated != 2 {
		t.Fatalf("both files should be journaled as created: %+v", summary.Counts)
	}
	if summary.Counts.EdgesAdded == 0 {
		t.Fatalf("the new call should be journaled as topology: %+v", summary.Counts)
	}
	for _, file := range summary.Files {
		if file.Language != "python" {
			t.Fatalf("journal lost the file's language: %+v", file)
		}
	}
	events, err := db.GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.RootID != root.ID || event.Branch != root.Branch {
			t.Fatalf("event lost watcher root identity: %#v", event)
		}
	}
}

func TestNoOpSaveIsNotJournaled(t *testing.T) {
	sqlDB, root, eventHub := journalFixture(t)
	path := filepath.Join(root.Path, "stable.py")
	writeLivingFixture(t, path, "def run():\n    return 1\n")
	if err := ReindexFile(sqlDB, eventHub, root, path); err != nil {
		t.Fatal(err)
	}

	before, err := db.GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	// Same bytes written again - a save, but not a change.
	writeLivingFixture(t, path, "def run():\n    return 1\n")
	if err := ReindexFile(sqlDB, eventHub, root, path); err != nil {
		t.Fatal(err)
	}
	after, err := db.GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("a no-op save must not enter the delta: %d → %d", len(before), len(after))
	}
}

func TestDependencySnapshotExcludesConcurrentWritesFromAnotherRoot(t *testing.T) {
	sqlDB, rootA, _ := journalFixture(t)
	rootB := db.Root{ID: "root-b", WorkspaceID: rootA.WorkspaceID, Path: t.TempDir(), Branch: "feature/b"}
	if err := db.UpsertRoot(sqlDB, rootB); err != nil {
		t.Fatal(err)
	}

	files := []db.File{
		{ID: "a-source", RootID: rootA.ID, Path: filepath.Join(rootA.Path, "a-source.ts"), RelPath: "a-source.ts", Language: "typescript"},
		{ID: "a-target", RootID: rootA.ID, Path: filepath.Join(rootA.Path, "a-target.ts"), RelPath: "a-target.ts", Language: "typescript"},
		{ID: "b-source", RootID: rootB.ID, Path: filepath.Join(rootB.Path, "b-source.ts"), RelPath: "b-source.ts", Language: "typescript"},
		{ID: "b-target", RootID: rootB.ID, Path: filepath.Join(rootB.Path, "b-target.ts"), RelPath: "b-target.ts", Language: "typescript"},
	}
	for _, file := range files {
		if err := db.UpsertFile(sqlDB, file); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.UpsertDependency(sqlDB, db.Dependency{
		ID: "a-import", WorkspaceID: rootA.WorkspaceID, Src: "a-source", Dst: "a-target",
		SrcType: "file", DstType: "file", DependencyType: "IMPORTS",
	}); err != nil {
		t.Fatal(err)
	}

	before, err := projectFileDependencies(sqlDB, rootA.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != 1 || before[0].ID != "a-import" {
		t.Fatalf("root A snapshot should contain its existing import: %#v", before)
	}

	// This models the exact interleaving that used to corrupt attribution:
	// root B commits an import between root A's before/after snapshots.
	if err := db.UpsertDependency(sqlDB, db.Dependency{
		ID: "b-import", WorkspaceID: rootB.WorkspaceID, Src: "b-source", Dst: "b-target",
		SrcType: "file", DstType: "file", DependencyType: "IMPORTS",
	}); err != nil {
		t.Fatal(err)
	}
	after, err := projectFileDependencies(sqlDB, rootA.ID)
	if err != nil {
		t.Fatal(err)
	}
	changes := diffRelationshipChanges(before, after, nil, nil, nil)
	if len(changes) != 0 {
		t.Fatalf("root B's concurrent dependency must not be attributed to root A: %#v", changes)
	}

	rootBDeps, err := projectFileDependencies(sqlDB, rootB.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(rootBDeps) != 1 || rootBDeps[0].ID != "b-import" {
		t.Fatalf("root B should retain its own dependency: %#v", rootBDeps)
	}
}

func TestRepeatedEditsCollapseToOneJournalRow(t *testing.T) {
	sqlDB, root, eventHub := journalFixture(t)
	path := filepath.Join(root.Path, "hot.py")
	writeLivingFixture(t, path, "def run():\n    return 1\n")
	if err := ReindexFile(sqlDB, eventHub, root, path); err != nil {
		t.Fatal(err)
	}
	for i, body := range []string{
		"def run():\n    return 2\n",
		"def run():\n    return 3\n",
		"def run():\n    return 4\n",
	} {
		writeLivingFixture(t, path, body)
		if err := ReindexFile(sqlDB, eventHub, root, path); err != nil {
			t.Fatalf("edit %d: %v", i, err)
		}
	}

	events, err := db.GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	updates := 0
	for _, ev := range events {
		if ev.Kind == db.EventFileUpdated {
			updates++
			if ev.Count != 3 {
				t.Fatalf("three edits should collapse into one row of count 3, got %d", ev.Count)
			}
		}
	}
	if updates != 1 {
		t.Fatalf("expected one collapsed update row, got %d", updates)
	}
}

func TestDeletedFileStillDescribesItselfInTheDelta(t *testing.T) {
	sqlDB, root, eventHub := journalFixture(t)
	path := filepath.Join(root.Path, "doomed.py")
	writeLivingFixture(t, path, "def run():\n    return 1\n")
	if err := ReindexFile(sqlDB, eventHub, root, path); err != nil {
		t.Fatal(err)
	}
	// Acknowledge the creation, so the delete stands alone in the next delta.
	reviewed := reviewedAt(t, sqlDB)

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := RemoveFile(sqlDB, eventHub, root, path); err != nil {
		t.Fatal(err)
	}

	summary := journalSummary(t, sqlDB, reviewed)
	if len(summary.Files) != 1 {
		t.Fatalf("expected the deletion alone, got %+v", summary.Files)
	}
	if summary.Files[0].Change != delta.ChangeDeleted {
		t.Fatalf("expected a deletion, got %q", summary.Files[0].Change)
	}
	if summary.Files[0].RelPath != "doomed.py" {
		t.Fatalf("a tombstone must still name the file, got %+v", summary.Files[0])
	}
}

func TestWatermarkNeverMovesBackwards(t *testing.T) {
	sqlDB, _, _ := journalFixture(t)
	if err := db.SetDeltaReviewedAt(sqlDB, "ws", 5000); err != nil {
		t.Fatal(err)
	}
	if err := db.SetDeltaReviewedAt(sqlDB, "ws", 1000); err != nil {
		t.Fatal(err)
	}
	at, err := db.GetDeltaReviewedAt(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if at != 5000 {
		t.Fatalf("a late ack must not resurrect a reviewed delta, got %d", at)
	}
}
