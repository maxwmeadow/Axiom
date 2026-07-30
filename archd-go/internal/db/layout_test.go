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

func TestFloorSystemContainmentUpdatesSemanticHierarchyAndDepth(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	parent := System{ID: "parent", WorkspaceID: "ws", Name: "parent", Source: "user", Depth: 2}
	child := System{ID: "child", WorkspaceID: "ws", Name: "child", Source: "user", Depth: 0}
	grandchild := System{ID: "grandchild", WorkspaceID: "ws", Name: "grandchild", Source: "user", Depth: 1, ParentID: stringPtr("child")}
	for _, system := range []System{parent, child, grandchild} {
		if err := UpsertSystem(sqlDB, system); err != nil {
			t.Fatal(err)
		}
	}
	parentID, parentType := parent.ID, "system"
	_, err = ApplyFloorLayoutBatch(sqlDB, "ws", []FloorLayout{{
		NodeID: child.ID, NodeType: "system", ParentNodeID: &parentID, ParentNodeType: &parentType,
		Width: 400, Height: 300, Scale: 1,
	}})
	if err != nil {
		t.Fatal(err)
	}
	gotChild, _ := GetSystem(sqlDB, child.ID)
	gotGrandchild, _ := GetSystem(sqlDB, grandchild.ID)
	if gotChild.ParentID == nil || *gotChild.ParentID != parent.ID || gotChild.Depth != 3 {
		t.Fatalf("child hierarchy: %#v", gotChild)
	}
	if gotGrandchild.Depth != 4 {
		t.Fatalf("grandchild depth = %d, want 4", gotGrandchild.Depth)
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
