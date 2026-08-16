package db

import (
	"database/sql"
	"testing"
)

// Floor geometry is measured against a parent frame. When a file changes
// systems, a row written against the frame it left is not stale - it is
// meaningless, and the file reappears at coordinates belonging to somewhere
// else. In practice that reads as the file vanishing.

func assignFixture(t *testing.T) (*sql.DB, string) {
	t.Helper()
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	for _, system := range []System{
		{ID: "sys-a", WorkspaceID: "ws", Name: "A", Source: "user"},
		{ID: "sys-b", WorkspaceID: "ws", Name: "B", Source: "user"},
	} {
		if err := UpsertSystem(sqlDB, system); err != nil {
			t.Fatal(err)
		}
	}
	if err := UpsertRoot(sqlDB, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertFile(sqlDB, File{ID: "file-1", RootID: "root", Path: "/x/a.py", RelPath: "a.py", Language: "python"}); err != nil {
		t.Fatal(err)
	}
	return sqlDB, "file-1"
}

func seedLayoutIn(t *testing.T, sqlDB *sql.DB, fileID, systemID string) {
	t.Helper()
	if _, err := sqlDB.Exec(`INSERT INTO floor_layouts(workspace_id,node_id,node_type,parent_node_id,parent_node_type,containment_kind,position_x,position_y,width,height,scale,interior_scale,updated_at)
		VALUES('ws',?,'file',?,'system','part_of',10,10,220,110,1,1,1)`, fileID, systemID); err != nil {
		t.Fatal(err)
	}
}

func layoutCount(t *testing.T, sqlDB *sql.DB, fileID string) int {
	t.Helper()
	var n int
	if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM floor_layouts WHERE node_type='file' AND node_id=?`, fileID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestAssignFileToSystemDropsLayoutFromTheSystemItLeft(t *testing.T) {
	sqlDB, fileID := assignFixture(t)
	if err := AssignFileToSystem(sqlDB, fileID, "sys-a"); err != nil {
		t.Fatal(err)
	}
	seedLayoutIn(t, sqlDB, fileID, "sys-a")

	if err := AssignFileToSystem(sqlDB, fileID, "sys-b"); err != nil {
		t.Fatal(err)
	}
	if n := layoutCount(t, sqlDB, fileID); n != 0 {
		t.Fatalf("geometry from the old system survived the move: %d rows", n)
	}
}

func TestAssignFileToSystemKeepsAuthoredGeometryWhenNothingMoved(t *testing.T) {
	sqlDB, fileID := assignFixture(t)
	if err := AssignFileToSystem(sqlDB, fileID, "sys-a"); err != nil {
		t.Fatal(err)
	}
	seedLayoutIn(t, sqlDB, fileID, "sys-a")

	// Re-asserting the placement it already has must not discard the position
	// the user arranged.
	if err := AssignFileToSystem(sqlDB, fileID, "sys-a"); err != nil {
		t.Fatal(err)
	}
	if n := layoutCount(t, sqlDB, fileID); n != 1 {
		t.Fatalf("an unchanged placement lost its layout: %d rows", n)
	}
}

func TestClearFileSystemDropsLayoutSoTheBinOwnsNoGeometry(t *testing.T) {
	sqlDB, fileID := assignFixture(t)
	if err := AssignFileToSystem(sqlDB, fileID, "sys-a"); err != nil {
		t.Fatal(err)
	}
	seedLayoutIn(t, sqlDB, fileID, "sys-a")

	if err := ClearFileSystem(sqlDB, fileID); err != nil {
		t.Fatal(err)
	}
	if n := layoutCount(t, sqlDB, fileID); n != 0 {
		t.Fatalf("an unsorted file kept geometry from its old system: %d rows", n)
	}
}
