package indexer

import (
	"os"
	"path/filepath"
	"testing"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/delta"
)

// Reconciliation stands in for the watcher across the window when archd was
// not running. If it does not work, the Morning Delta is empty in exactly the
// situation it was built for.

func TestReconcileCatchesUpOnWorkDoneWhileClosed(t *testing.T) {
	sqlDB, root, eventHub := journalFixture(t)
	writeLivingFixture(t, filepath.Join(root.Path, "seed.py"), "def seed():\n    return 1\n")
	if err := IndexRoot(sqlDB, eventHub, root, nil); err != nil {
		t.Fatal(err)
	}
	// Everything so far is the project's baseline, not a delta.
	reviewed := reviewedAt(t, sqlDB)

	// ─── archd is "not running" here; an agent works the tree ───
	writeLivingFixture(t, filepath.Join(root.Path, "worker.py"), "def transform(value):\n    return value + 1\n")
	writeLivingFixture(t, filepath.Join(root.Path, "seed.py"),
		"from worker import transform\n\ndef seed():\n    return transform(1)\n")

	changed, err := ReconcileRoot(sqlDB, eventHub, root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if changed != 2 {
		t.Fatalf("expected the new file and the edited file, got %d", changed)
	}
	seed, err := db.GetFileByRelPath(sqlDB, root.ID, "seed.py")
	if err != nil {
		t.Fatal(err)
	}
	worker, err := db.GetFileByRelPath(sqlDB, root.ID, "worker.py")
	if err != nil {
		t.Fatal(err)
	}
	if seed == nil || worker == nil || seed.SystemID == nil || worker.SystemID == nil {
		t.Fatalf("reopen catch-up left new semantic peers unclassified: seed=%#v worker=%#v", seed, worker)
	}
	if *seed.SystemID != *worker.SystemID {
		t.Fatalf("reopen classification split semantic peers: %s != %s", *seed.SystemID, *worker.SystemID)
	}

	summary := journalSummary(t, sqlDB, reviewed)
	if summary.Counts.FilesCreated != 1 {
		t.Fatalf("the file written while closed should read as created: %+v", summary.Counts)
	}
	if summary.Counts.FilesUpdated != 1 {
		t.Fatalf("the file edited while closed should read as edited: %+v", summary.Counts)
	}
	if summary.Counts.EdgesAdded == 0 {
		t.Fatalf("the new call written while closed should appear as topology: %+v", summary.Counts)
	}
}

func TestReconcileNoticesDeletionsMadeWhileClosed(t *testing.T) {
	sqlDB, root, eventHub := journalFixture(t)
	doomed := filepath.Join(root.Path, "doomed.py")
	writeLivingFixture(t, filepath.Join(root.Path, "kept.py"), "def kept():\n    return 1\n")
	writeLivingFixture(t, doomed, "def doomed():\n    return 2\n")
	if err := IndexRoot(sqlDB, eventHub, root, nil); err != nil {
		t.Fatal(err)
	}
	reviewed := reviewedAt(t, sqlDB)

	if err := os.Remove(doomed); err != nil {
		t.Fatal(err)
	}
	if _, err := ReconcileRoot(sqlDB, eventHub, root, nil); err != nil {
		t.Fatal(err)
	}

	summary := journalSummary(t, sqlDB, reviewed)
	if len(summary.Files) != 1 || summary.Files[0].Change != delta.ChangeDeleted {
		t.Fatalf("expected exactly one deletion, got %+v", summary.Files)
	}
	if summary.Files[0].RelPath != "doomed.py" {
		t.Fatalf("wrong file reported deleted: %+v", summary.Files[0])
	}
	if file, _ := db.GetFileByRelPath(sqlDB, root.ID, "doomed.py"); file != nil {
		t.Fatal("the deleted file should be gone from the graph too")
	}
}

func TestReconcileOnAnUntouchedTreeIsSilent(t *testing.T) {
	sqlDB, root, eventHub := journalFixture(t)
	writeLivingFixture(t, filepath.Join(root.Path, "stable.py"), "def stable():\n    return 1\n")
	if err := IndexRoot(sqlDB, eventHub, root, nil); err != nil {
		t.Fatal(err)
	}
	before, err := db.GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}

	changed, err := ReconcileRoot(sqlDB, eventHub, root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if changed != 0 {
		t.Fatalf("nothing moved on disk, so nothing should be re-indexed; got %d", changed)
	}
	after, err := db.GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("reopening an untouched project must not invent a delta: %d → %d", len(before), len(after))
	}
}
