package db

import "testing"

func TestDeltaSnapshotsAreExactAndDurableAtReviewBoundaries(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}

	if err := SaveDeltaSnapshot(sqlDB, "ws", 100, `{"systems":{"a":"A"}}`); err != nil {
		t.Fatal(err)
	}
	if err := SaveDeltaSnapshot(sqlDB, "ws", 200, `{"systems":{"b":"B"}}`); err != nil {
		t.Fatal(err)
	}
	got, err := GetDeltaSnapshot(sqlDB, "ws", 100)
	if err != nil {
		t.Fatal(err)
	}
	if got != `{"systems":{"a":"A"}}` {
		t.Fatalf("snapshot at 100 = %q", got)
	}
	missing, err := GetDeltaSnapshot(sqlDB, "ws", 150)
	if err != nil {
		t.Fatal(err)
	}
	if missing != "" {
		t.Fatalf("an inexact boundary must not reuse another graph: %q", missing)
	}
}
