package db

import (
	"encoding/json"
	"testing"
)

func TestSheetLayoutUpdatesPositionParentAndRevisionAtomically(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	parent := "system-parent"
	for _, system := range []System{
		{ID: "system-child", WorkspaceID: "ws", Name: "child", Source: "user"},
		{ID: parent, WorkspaceID: "ws", Name: "parent", Source: "user"},
	} {
		if err := UpsertSystem(sqlDB, system); err != nil {
			t.Fatal(err)
		}
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "drawing"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	element := SheetElement{ID: "element", SheetID: sheet.ID, SystemID: ptr("system-child"), Label: "child"}
	if err := AddSheetElement(sqlDB, &element); err != nil {
		t.Fatal(err)
	}
	before, err := GetSheet(sqlDB, sheet.ID)
	if err != nil {
		t.Fatal(err)
	}

	width, height := 640.0, 480.0
	if err := UpdateSheetElementLayout(sqlDB, element.ID, 125.5, 240.25, &parent, &width, &height, nil); err != nil {
		t.Fatal(err)
	}
	elements, err := GetSheetElements(sqlDB, sheet.ID)
	if err != nil {
		t.Fatal(err)
	}
	after, err := GetSheet(sqlDB, sheet.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(elements) != 1 || elements[0].PositionX != 125.5 || elements[0].PositionY != 240.25 {
		t.Fatalf("unexpected persisted position: %#v", elements)
	}
	if elements[0].ParentSystemID == nil || *elements[0].ParentSystemID != parent {
		t.Fatalf("unexpected persisted parent: %#v", elements[0].ParentSystemID)
	}
	if elements[0].Width == nil || *elements[0].Width != width || elements[0].Height == nil || *elements[0].Height != height {
		t.Fatalf("unexpected persisted size: %#v x %#v", elements[0].Width, elements[0].Height)
	}
	if after.Revision != before.Revision+1 {
		t.Fatalf("revision = %d, want %d", after.Revision, before.Revision+1)
	}

	parentElement := SheetElement{ID: "parent-element", SheetID: sheet.ID, SystemID: &parent, Label: "parent"}
	if err := AddSheetElement(sqlDB, &parentElement); err != nil {
		t.Fatal(err)
	}
	child := "system-child"
	if err := ValidateSheetElementParent(sqlDB, sheet.ID, parentElement.ID, &child); err == nil {
		t.Fatal("expected sheet-local containment cycle to be rejected")
	}
}

func TestPlannedLayoutUpdatesPositionParentAndRevisionAtomically(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	parent := "system-parent"
	if err := UpsertSystem(sqlDB, System{ID: parent, WorkspaceID: "ws", Name: "parent", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "drawing"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	planned := PlannedNode{
		ID: "planned", SheetID: sheet.ID, WorkspaceID: "ws", Name: "FutureClass",
		Members: json.RawMessage("[]"),
	}
	if err := UpsertPlannedNode(sqlDB, &planned); err != nil {
		t.Fatal(err)
	}
	before, err := GetSheet(sqlDB, sheet.ID)
	if err != nil {
		t.Fatal(err)
	}

	width, height := 320.0, 220.0
	if err := UpdatePlannedLayout(sqlDB, planned.ID, 40, 80, &parent, &width, &height, nil); err != nil {
		t.Fatal(err)
	}
	nodes, err := GetPlannedNodes(sqlDB, sheet.ID)
	if err != nil {
		t.Fatal(err)
	}
	after, err := GetSheet(sqlDB, sheet.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 1 || nodes[0].PositionX != 40 || nodes[0].PositionY != 80 {
		t.Fatalf("unexpected planned position: %#v", nodes)
	}
	if nodes[0].ParentSystemID == nil || *nodes[0].ParentSystemID != parent {
		t.Fatalf("unexpected planned parent: %#v", nodes[0].ParentSystemID)
	}
	if nodes[0].Width == nil || *nodes[0].Width != width || nodes[0].Height == nil || *nodes[0].Height != height {
		t.Fatalf("unexpected planned size: %#v x %#v", nodes[0].Width, nodes[0].Height)
	}
	if after.Revision != before.Revision+1 {
		t.Fatalf("revision = %d, want %d", after.Revision, before.Revision+1)
	}
}

func TestUnifiedSheetContainmentAcceptsPlannedSystemsAndRejectsCycles(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "drawing"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	parent := PlannedNode{
		ID: "parent", SheetID: sheet.ID, WorkspaceID: "ws", Kind: "system", Name: "Parent",
		Members: json.RawMessage("[]"),
	}
	parentRef := "planned:" + parent.ID
	child := PlannedNode{
		ID: "child", SheetID: sheet.ID, WorkspaceID: "ws", Kind: "system", Name: "Child",
		Members: json.RawMessage("[]"), ParentSystemID: &parentRef,
	}
	if err := UpsertPlannedNode(sqlDB, &parent); err != nil {
		t.Fatal(err)
	}
	if err := UpsertPlannedNode(sqlDB, &child); err != nil {
		t.Fatal(err)
	}
	if err := ValidateSheetParent(sqlDB, sheet.ID, &parentRef); err != nil {
		t.Fatalf("planned system should be a valid sheet parent: %v", err)
	}
	childRef := "planned:" + child.ID
	if err := ValidatePlannedParent(sqlDB, parent.ID, &childRef); err == nil {
		t.Fatal("expected planned-system containment cycle to be rejected")
	}
}

func TestSheetDesignMetadataAndContainerInfraRoundTrip(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "drawing"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSystem(sqlDB, System{ID: "live-file-parent", WorkspaceID: "ws", Name: "src", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	element := SheetElement{ID: "element", SheetID: sheet.ID, SystemID: ptr("live-file-parent"), Label: "src"}
	if err := AddSheetElement(sqlDB, &element); err != nil {
		t.Fatal(err)
	}
	metadata := json.RawMessage(`{"version":1,"symbols":[{"name":"findUser","kind":"function"}]}`)
	if err := UpdateSheetElementDesignMetadata(sqlDB, sheet.ID, element.ID, metadata); err != nil {
		t.Fatal(err)
	}
	elements, err := GetSheetElements(sqlDB, sheet.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(elements) != 1 || string(elements[0].DesignMetadata) != string(metadata) {
		t.Fatalf("design metadata = %s, want %s", elements[0].DesignMetadata, metadata)
	}
	if err := UpdateSheetElementDesignMetadata(sqlDB, sheet.ID, element.ID, json.RawMessage(`[]`)); err == nil {
		t.Fatal("expected non-object design metadata to be rejected")
	}

	container := PlannedNode{
		ID: "hosting", SheetID: sheet.ID, WorkspaceID: "ws", Kind: "infra", Name: "App Service",
		Metadata: json.RawMessage(`{"version":1,"category":"platform","capabilities":["container","environment"]}`),
	}
	if err := UpsertPlannedNode(sqlDB, &container); err != nil {
		t.Fatal(err)
	}
	containerRef := "planned:" + container.ID
	if err := ValidateSheetParent(sqlDB, sheet.ID, &containerRef); err != nil {
		t.Fatalf("container-capable infrastructure should accept children: %v", err)
	}
}

func TestPlannedNodeMetadataRoundTripsAsStructuredJSON(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "drawing"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}

	metadata := json.RawMessage(`{"version":1,"attributes":[{"visibility":"private","name":"repository","dataType":"UserRepository"}],"methods":[{"visibility":"public","name":"findUser","parameters":[{"name":"id","dataType":"UUID"}],"returnType":"User"}]}`)
	node := PlannedNode{ID: "class", SheetID: sheet.ID, WorkspaceID: "ws", Kind: "class", Name: "UserService", Metadata: metadata}
	if err := UpsertPlannedNode(sqlDB, &node); err != nil {
		t.Fatal(err)
	}
	got, err := GetPlannedNode(sqlDB, node.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || string(got.Metadata) != string(metadata) {
		t.Fatalf("metadata = %s, want %s", got.Metadata, metadata)
	}

	node.Metadata = json.RawMessage(`[]`)
	if err := UpsertPlannedNode(sqlDB, &node); err == nil {
		t.Fatal("expected non-object metadata to be rejected")
	}
}

func TestSheetNodesNormalizeDefaultScaleBeforeReturning(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "drawing"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	planned := PlannedNode{SheetID: sheet.ID, WorkspaceID: "ws", Name: "Future"}
	if err := UpsertPlannedNode(sqlDB, &planned); err != nil {
		t.Fatal(err)
	}
	if planned.Scale != 1 {
		t.Fatalf("planned scale = %v, want 1", planned.Scale)
	}
	symbolRef := "symbol"
	element := SheetElement{SheetID: sheet.ID, SymbolRef: &symbolRef, Label: "Live"}
	if err := AddSheetElement(sqlDB, &element); err != nil {
		t.Fatal(err)
	}
	if element.Scale != 1 {
		t.Fatalf("element scale = %v, want 1", element.Scale)
	}
}

func TestSheetLayoutBatchMovesMixedSelectionInOneRevision(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSystem(sqlDB, System{ID: "live", WorkspaceID: "ws", Name: "live", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "drawing"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	element := SheetElement{ID: "element", SheetID: sheet.ID, SystemID: ptr("live"), Label: "live"}
	if err := AddSheetElement(sqlDB, &element); err != nil {
		t.Fatal(err)
	}
	planned := PlannedNode{ID: "planned", SheetID: sheet.ID, WorkspaceID: "ws", Kind: "class", Name: "Future"}
	if err := UpsertPlannedNode(sqlDB, &planned); err != nil {
		t.Fatal(err)
	}
	before, _ := GetSheet(sqlDB, sheet.ID)
	width, height, scale := 300.0, 180.0, 0.4
	if err := UpdateSheetLayouts(sqlDB, sheet.ID, []SheetLayoutUpdate{
		{Kind: "element", ID: element.ID, X: 20, Y: 30, Width: &width, Height: &height, Scale: &scale},
		{Kind: "planned", ID: planned.ID, X: 120, Y: 130, Width: &width, Height: &height, Scale: &scale},
	}); err != nil {
		t.Fatal(err)
	}
	after, _ := GetSheet(sqlDB, sheet.ID)
	if after.Revision != before.Revision+1 {
		t.Fatalf("revision = %d, want %d", after.Revision, before.Revision+1)
	}
	elements, _ := GetSheetElements(sqlDB, sheet.ID)
	plannedNodes, _ := GetPlannedNodes(sqlDB, sheet.ID)
	if len(elements) != 1 || elements[0].Scale != scale || elements[0].PositionX != 20 {
		t.Fatalf("element layout: %#v", elements)
	}
	if len(plannedNodes) != 1 || plannedNodes[0].Scale != scale || plannedNodes[0].PositionX != 120 {
		t.Fatalf("planned layout: %#v", plannedNodes)
	}
}

func TestSheetLayoutBatchRejectsNewCycleWithoutPartialCommit(t *testing.T) {
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
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "drawing"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	for _, element := range []SheetElement{
		{ID: "ea", SheetID: sheet.ID, SystemID: ptr("a"), Label: "a"},
		{ID: "eb", SheetID: sheet.ID, SystemID: ptr("b"), Label: "b"},
	} {
		if err := AddSheetElement(sqlDB, &element); err != nil {
			t.Fatal(err)
		}
	}
	before, _ := GetSheet(sqlDB, sheet.ID)
	if err := UpdateSheetLayouts(sqlDB, sheet.ID, []SheetLayoutUpdate{
		{Kind: "element", ID: "ea", X: 10, Y: 20, ParentSystemID: ptr("b")},
		{Kind: "element", ID: "eb", X: 30, Y: 40, ParentSystemID: ptr("a")},
	}); err == nil {
		t.Fatal("expected cycle rejection")
	}
	after, _ := GetSheet(sqlDB, sheet.ID)
	if after.Revision != before.Revision {
		t.Fatalf("failed batch changed revision: %d -> %d", before.Revision, after.Revision)
	}
	elements, _ := GetSheetElements(sqlDB, sheet.ID)
	for _, element := range elements {
		if element.ParentSystemID != nil || element.PositionX != 0 || element.PositionY != 0 {
			t.Fatalf("failed batch partially committed: %#v", element)
		}
	}
}

func TestSheetLayoutBatchCycleCheckIncludesUnlistedLiveAncestors(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSystem(sqlDB, System{ID: "b", WorkspaceID: "ws", Name: "b", Source: "user"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSystem(sqlDB, System{ID: "a", WorkspaceID: "ws", Name: "a", Source: "user", ParentID: ptr("b")}); err != nil {
		t.Fatal(err)
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "drawing"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	// Only B is explicitly on the Sheet. A still inherits A -> B from the live
	// Floor, so placing B under A must be rejected as B -> A -> B.
	element := SheetElement{ID: "eb", SheetID: sheet.ID, SystemID: ptr("b"), Label: "b"}
	if err := AddSheetElement(sqlDB, &element); err != nil {
		t.Fatal(err)
	}
	if err := UpdateSheetLayouts(sqlDB, sheet.ID, []SheetLayoutUpdate{{
		Kind: "element", ID: element.ID, ParentSystemID: ptr("a"), X: 1, Y: 2,
	}}); err == nil {
		t.Fatal("expected inherited live-parent cycle rejection")
	}
}

func ptr(value string) *string { return &value }
