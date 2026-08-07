package db

import (
	"reflect"
	"testing"
)

func TestRootPersistsCompletedSourceBoundaries(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "scope"}); err != nil {
		t.Fatal(err)
	}
	reviewedAt := int64(1234)
	root := Root{
		ID: "root", WorkspaceID: "ws", Path: "C:/project",
		Branch: "main", HeadCommit: "abc123", IsPrimary: true, IsActive: true,
		IgnoredPaths:               []string{"C:/project/generated/**"},
		SourceBoundariesReviewedAt: &reviewedAt,
	}
	if err := UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	if err := MarkRootIndexed(sqlDB, root.ID, 3); err != nil {
		t.Fatal(err)
	}

	roots, err := GetRoots(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 1 {
		t.Fatalf("roots = %d, want 1", len(roots))
	}
	got := roots[0]
	if got.SourceBoundariesReviewedAt == nil || *got.SourceBoundariesReviewedAt != reviewedAt {
		t.Fatalf("review timestamp = %#v, want %d", got.SourceBoundariesReviewedAt, reviewedAt)
	}
	if !reflect.DeepEqual(got.IgnoredPaths, root.IgnoredPaths) {
		t.Fatalf("ignored paths = %#v, want %#v", got.IgnoredPaths, root.IgnoredPaths)
	}
	if got.IndexedAt == nil || *got.IndexedAt <= 0 {
		t.Fatal("root should remain marked indexed")
	}
	if got.Branch != root.Branch || got.HeadCommit != root.HeadCommit || !got.IsPrimary || !got.IsActive {
		t.Fatalf("git identity was not preserved: %#v", got)
	}
}

func TestDeactivateRootRemovesOnlyItsLiveGraph(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "roots"}); err != nil {
		t.Fatal(err)
	}
	for _, root := range []Root{
		{ID: "primary", WorkspaceID: "ws", Path: "C:/primary", IsPrimary: true, IsActive: true},
		{ID: "branch", WorkspaceID: "ws", Path: "C:/branch", Branch: "feature", IsActive: true},
	} {
		if err := UpsertRoot(sqlDB, root); err != nil {
			t.Fatal(err)
		}
		if err := MarkRootIndexed(sqlDB, root.ID, 3); err != nil {
			t.Fatal(err)
		}
		if err := UpsertFile(sqlDB, File{ID: root.ID + "-file", RootID: root.ID, Path: root.Path + "/file.go", RelPath: "file.go"}); err != nil {
			t.Fatal(err)
		}
	}

	if err := DeactivateRoot(sqlDB, "branch"); err != nil {
		t.Fatal(err)
	}
	primaryFiles, err := GetFilesByRoot(sqlDB, "primary")
	if err != nil || len(primaryFiles) != 1 {
		t.Fatalf("primary files changed: files=%#v err=%v", primaryFiles, err)
	}
	branchFiles, err := GetFilesByRoot(sqlDB, "branch")
	if err != nil || len(branchFiles) != 0 {
		t.Fatalf("removed branch files remain: files=%#v err=%v", branchFiles, err)
	}
	roots, err := GetRoots(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 2 || roots[0].ID != "primary" || roots[1].IsActive || roots[1].IndexedAt != nil {
		t.Fatalf("root lifecycle state = %#v", roots)
	}
}

func TestClusterPruningKeepsSystemUsedBySiblingRoot(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "roots"}); err != nil {
		t.Fatal(err)
	}
	for _, rootID := range []string{"primary", "branch"} {
		if err := UpsertRoot(sqlDB, Root{ID: rootID, WorkspaceID: "ws", Path: "C:/" + rootID}); err != nil {
			t.Fatal(err)
		}
	}
	system := System{ID: "shared-system", WorkspaceID: "ws", Name: "Payments", Source: "cluster"}
	if err := UpsertSystem(sqlDB, system); err != nil {
		t.Fatal(err)
	}
	for _, rootID := range []string{"primary", "branch"} {
		systemID := system.ID
		if err := UpsertFile(sqlDB, File{
			ID: rootID + "-file", RootID: rootID, Path: "C:/" + rootID + "/file.go",
			RelPath: "file.go", SystemID: &systemID,
		}); err != nil {
			t.Fatal(err)
		}
	}

	if err := ApplyClusterPlan(
		sqlDB,
		"ws",
		nil,
		[]FileSystemAssignment{{FileID: "branch-file", SystemID: nil}},
		[]string{system.ID},
	); err != nil {
		t.Fatal(err)
	}
	systems, err := GetSystems(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(systems) != 1 || systems[0].ID != system.ID {
		t.Fatalf("sibling root's system was pruned: %#v", systems)
	}
}
