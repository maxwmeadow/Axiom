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
}
