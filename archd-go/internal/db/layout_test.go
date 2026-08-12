package db

import "testing"

func TestFloorLayoutBatchSeparatesVisualAndSemanticParents(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	for _, system := range []System{
		{ID: "semantic-parent", WorkspaceID: "ws", Name: "Semantic", Source: "user"},
		{ID: "child", WorkspaceID: "ws", Name: "Child", Source: "user", ParentID: stringPtr("semantic-parent")},
	} {
		if err := UpsertSystem(sqlDB, system); err != nil {
			t.Fatal(err)
		}
	}
	if err := UpsertInfraNode(sqlDB, &InfraNode{ID: "host", WorkspaceID: "ws", Name: "Host", Category: "platform", Provider: "generic", Status: "confirmed"}); err != nil {
		t.Fatal(err)
	}

	parentID, parentType := "host", "infra"
	result, err := ApplyFloorLayoutBatch(sqlDB, "ws", []FloorLayout{
		{NodeID: "host", NodeType: "infra", PositionX: 10, PositionY: 20, Width: 800, Height: 600, Scale: 1},
		{NodeID: "child", NodeType: "system", ParentNodeID: &parentID, ParentNodeType: &parentType, PositionX: 50, PositionY: 70, Width: 400, Height: 300, Scale: .5},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != 1 || len(result.Layouts) != 2 {
		t.Fatalf("unexpected result: %#v", result)
	}

	child, err := GetSystem(sqlDB, "child")
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentID == nil || *child.ParentID != "semantic-parent" {
		t.Fatalf("visual hosting changed semantic parent: %#v", child.ParentID)
	}
	layouts, err := GetFloorLayouts(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(layouts) != 2 {
		t.Fatalf("layouts = %d, want 2", len(layouts))
	}
	for _, layout := range layouts {
		if layout.NodeID == "child" && layout.ContainmentKind != "hosted_by" {
			t.Fatalf("containment = %q, want hosted_by", layout.ContainmentKind)
		}
	}
}

func TestFloorLayoutBatchRejectsCyclesAtomically(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b"} {
		if err := UpsertSystem(sqlDB, System{ID: id, WorkspaceID: "ws", Name: id, Source: "user"}); err != nil {
			t.Fatal(err)
		}
	}
	a, b, systemType := "a", "b", "system"
	_, err = ApplyFloorLayoutBatch(sqlDB, "ws", []FloorLayout{
		{NodeID: "a", NodeType: "system", ParentNodeID: &b, ParentNodeType: &systemType, Width: 100, Height: 100, Scale: 1},
		{NodeID: "b", NodeType: "system", ParentNodeID: &a, ParentNodeType: &systemType, Width: 100, Height: 100, Scale: 1},
	})
	if err == nil {
		t.Fatal("expected cycle rejection")
	}
	layouts, err := GetFloorLayouts(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(layouts) != 0 {
		t.Fatalf("failed batch partially committed: %#v", layouts)
	}
}

func TestFloorLayoutBatchNeverChangesSemanticOwnership(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	semanticParent := System{ID: "semantic-parent", WorkspaceID: "ws", Name: "semantic-parent", Source: "user", Depth: 1}
	visualParent := System{ID: "visual-parent", WorkspaceID: "ws", Name: "visual-parent", Source: "user", Depth: 4}
	child := System{ID: "child", WorkspaceID: "ws", Name: "child", Source: "user", Depth: 2, ParentID: stringPtr(semanticParent.ID)}
	grandchild := System{ID: "grandchild", WorkspaceID: "ws", Name: "grandchild", Source: "user", Depth: 3, ParentID: stringPtr(child.ID)}
	for _, system := range []System{semanticParent, visualParent, child, grandchild} {
		if err := UpsertSystem(sqlDB, system); err != nil {
			t.Fatal(err)
		}
	}
	if err := UpsertRoot(sqlDB, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	file := File{ID: "file", RootID: "root", Path: "file.go", RelPath: "file.go", Language: "go", SystemID: stringPtr(semanticParent.ID)}
	if err := UpsertFile(sqlDB, file); err != nil {
		t.Fatal(err)
	}

	parentType := "system"
	_, err = ApplyFloorLayoutBatch(sqlDB, "ws", []FloorLayout{
		{NodeID: child.ID, NodeType: "system", ParentNodeID: stringPtr(visualParent.ID), ParentNodeType: &parentType, Width: 400, Height: 300, Scale: 1},
		{NodeID: file.ID, NodeType: "file", ParentNodeID: stringPtr(visualParent.ID), ParentNodeType: &parentType, Width: 200, Height: 100, Scale: 1},
	})
	if err != nil {
		t.Fatal(err)
	}

	gotChild, err := GetSystem(sqlDB, child.ID)
	if err != nil {
		t.Fatal(err)
	}
	gotGrandchild, err := GetSystem(sqlDB, grandchild.ID)
	if err != nil {
		t.Fatal(err)
	}
	gotFile, err := GetFileByID(sqlDB, file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gotChild.ParentID == nil || *gotChild.ParentID != semanticParent.ID || gotChild.Depth != child.Depth {
		t.Fatalf("visual system placement changed semantic hierarchy: %#v", gotChild)
	}
	if gotGrandchild.Depth != grandchild.Depth {
		t.Fatalf("visual system placement changed descendant depth: got %d want %d", gotGrandchild.Depth, grandchild.Depth)
	}
	if gotFile.SystemID == nil || *gotFile.SystemID != semanticParent.ID {
		t.Fatalf("visual file placement changed semantic ownership: %#v", gotFile.SystemID)
	}

	// Moving both nodes to visual root must be equally semantic-neutral.
	_, err = ApplyFloorLayoutBatch(sqlDB, "ws", []FloorLayout{
		{NodeID: child.ID, NodeType: "system", Width: 400, Height: 300, Scale: 1},
		{NodeID: file.ID, NodeType: "file", Width: 200, Height: 100, Scale: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	gotChild, _ = GetSystem(sqlDB, child.ID)
	gotFile, _ = GetFileByID(sqlDB, file.ID)
	if gotChild.ParentID == nil || *gotChild.ParentID != semanticParent.ID || gotChild.Depth != child.Depth {
		t.Fatalf("visual root placement changed semantic hierarchy: %#v", gotChild)
	}
	if gotFile.SystemID == nil || *gotFile.SystemID != semanticParent.ID {
		t.Fatalf("visual root placement changed semantic ownership: %#v", gotFile.SystemID)
	}
	layouts, err := GetFloorLayouts(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(layouts) != 2 {
		t.Fatalf("layouts = %d, want 2", len(layouts))
	}
	for _, layout := range layouts {
		if layout.ContainmentKind != "root" || layout.ParentNodeID != nil || layout.ParentNodeType != nil {
			t.Fatalf("visual root layout was not persisted: %#v", layout)
		}
	}
}

func stringPtr(value string) *string { return &value }

// Interior compression is a persistent property of a container, distinct from
// its own scale. It has to survive a round trip, and a client that predates it
// must not be able to silently reset one that already exists.
func TestFloorLayoutInteriorScaleRoundTrips(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSystem(sqlDB, System{ID: "frame", WorkspaceID: "ws", Name: "Frame", Source: "user"}); err != nil {
		t.Fatal(err)
	}

	if _, err := ApplyFloorLayoutBatch(sqlDB, "ws", []FloorLayout{{
		NodeID: "frame", NodeType: "system",
		Width: 620, Height: 420, Scale: 1, InteriorScale: 0.75,
	}}); err != nil {
		t.Fatal(err)
	}
	layouts, err := GetFloorLayouts(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(layouts) != 1 || layouts[0].InteriorScale != 0.75 {
		t.Fatalf("interior scale did not round trip: %#v", layouts)
	}
	// A frame's own scale and its interior scale must stay independent.
	if layouts[0].Scale != 1 {
		t.Fatalf("interior compression leaked into the frame's own scale: %#v", layouts[0])
	}

	// A legacy client omits the field entirely, which decodes as zero.
	if _, err := ApplyFloorLayoutBatch(sqlDB, "ws", []FloorLayout{{
		NodeID: "frame", NodeType: "system", Width: 620, Height: 420, Scale: 1,
	}}); err != nil {
		t.Fatal(err)
	}
	layouts, err = GetFloorLayouts(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if layouts[0].InteriorScale != 1 {
		t.Fatalf("omitted interior scale = %v, want the normalized 1", layouts[0].InteriorScale)
	}
}

func TestFloorLayoutRejectsNegativeInteriorScale(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSystem(sqlDB, System{ID: "frame", WorkspaceID: "ws", Name: "Frame", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	if _, err := ApplyFloorLayoutBatch(sqlDB, "ws", []FloorLayout{{
		NodeID: "frame", NodeType: "system",
		Width: 620, Height: 420, Scale: 1, InteriorScale: -0.5,
	}}); err == nil {
		t.Fatal("expected a negative interior scale to be rejected")
	}
}
