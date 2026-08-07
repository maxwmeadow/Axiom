package db

import "testing"

func TestCanonicalSheetLayoutMatchesFloorAlgebraWithoutChangingOwnership(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	for _, system := range []System{
		{ID: "parent", WorkspaceID: "ws", Name: "parent", Source: "user"},
		{ID: "child", WorkspaceID: "ws", Name: "child", Source: "user"},
	} {
		if err := UpsertSystem(sqlDB, system); err != nil {
			t.Fatal(err)
		}
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "proposal"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}

	parentID, parentType := "parent", "system"
	result, err := ApplySheetLayoutBatch(sqlDB, sheet.ID, "ws", []SheetLayout{{
		NodeID:          "child",
		NodeType:        "system",
		ParentNodeID:    &parentID,
		ParentNodeType:  &parentType,
		ContainmentKind: "part_of",
		PositionX:       12.5,
		PositionY:       33.25,
		Width:           640,
		Height:          480,
		Scale:           0.75,
		InteriorScale:   0.625,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != int64(sheet.Revision+1) {
		t.Fatalf("revision = %d, want %d", result.Revision, sheet.Revision+1)
	}
	layouts, err := GetSheetLayouts(sqlDB, sheet.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(layouts) != 1 {
		t.Fatalf("layouts = %#v", layouts)
	}
	got := layouts[0]
	if got.PositionX != 12.5 || got.PositionY != 33.25 ||
		got.Width != 640 || got.Height != 480 ||
		got.Scale != 0.75 || got.InteriorScale != 0.625 {
		t.Fatalf("canonical geometry was not preserved: %#v", got)
	}
	child, err := GetSystem(sqlDB, "child")
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentID != nil {
		t.Fatalf("sheet layout changed semantic ownership: %#v", child.ParentID)
	}
}

func TestCanonicalSheetLayoutRejectsCyclesAcrossFloorAndSheetOverrides(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	for _, system := range []System{
		{ID: "a", WorkspaceID: "ws", Name: "a", Source: "user"},
		{ID: "b", WorkspaceID: "ws", Name: "b", Source: "user"},
	} {
		if err := UpsertSystem(sqlDB, system); err != nil {
			t.Fatal(err)
		}
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "proposal"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	a, b, systemType := "a", "b", "system"
	_, err = ApplySheetLayoutBatch(sqlDB, sheet.ID, "ws", []SheetLayout{
		{
			NodeID: "a", NodeType: "system", ParentNodeID: &b, ParentNodeType: &systemType,
			Width: 620, Height: 420, Scale: 1, InteriorScale: 1,
		},
		{
			NodeID: "b", NodeType: "system", ParentNodeID: &a, ParentNodeType: &systemType,
			Width: 620, Height: 420, Scale: 1, InteriorScale: 1,
		},
	})
	if err == nil {
		t.Fatal("expected canonical sheet layout cycle to be rejected")
	}
}
