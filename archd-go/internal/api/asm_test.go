package api

import (
	"encoding/json"
	"strings"
	"testing"

	"axiom.local/archd/internal/db"
)

func TestAgentSheetContextIncludesLiveFloorAndAuthoredPlacement(t *testing.T) {
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	liveSystem := db.System{ID: "auth", WorkspaceID: "ws", Name: "Authentication", Source: "directory"}
	if err := db.UpsertSystem(sqlDB, liveSystem); err != nil {
		t.Fatal(err)
	}
	sheet := db.Sheet{ID: "sheet", WorkspaceID: "ws", Name: "Auth redesign"}
	if err := db.CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	if err := db.AddSheetElement(sqlDB, &db.SheetElement{
		ID: "auth-element", SheetID: sheet.ID, SystemID: &liveSystem.ID, Label: liveSystem.Name,
		PositionX: 40, PositionY: 80,
		DesignMetadata: json.RawMessage(`{"version":1,"description":"Keep the live identity but author Sheet-local intent"}`),
	}); err != nil {
		t.Fatal(err)
	}
	parent := liveSystem.ID
	metadata := json.RawMessage(`{"version":1,"methods":[{"visibility":"public","name":"login","parameters":[],"returnType":"Session"}]}`)
	if err := db.UpsertPlannedNode(sqlDB, &db.PlannedNode{
		ID: "service", SheetID: sheet.ID, WorkspaceID: "ws", Kind: "class", Name: "AuthService",
		Metadata: metadata, ParentSystemID: &parent, PositionX: 120, PositionY: 160,
	}); err != nil {
		t.Fatal(err)
	}

	context, err := renderAgentSheetContext(sqlDB, &sheet)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"uri": "sys://Authentication"`,
		`"parentRef": "sys://Authentication"`,
		`"name": "login"`,
		`"description": "Keep the live identity but author Sheet-local intent"`,
		`"x": 120`,
	} {
		if !strings.Contains(context, want) {
			t.Fatalf("context missing %s:\n%s", want, context)
		}
	}
}

func TestBuildSpecExcludesUnapprovedAgentProposals(t *testing.T) {
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	sheet := db.Sheet{ID: "sheet", WorkspaceID: "ws", Name: "Next increment"}
	if err := db.CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	for _, node := range []db.PlannedNode{
		{ID: "approved", SheetID: sheet.ID, WorkspaceID: "ws", Name: "Checkout", DeclaredPath: "checkout.go"},
		{ID: "proposal", SheetID: sheet.ID, WorkspaceID: "ws", Name: "SpeculativeCache", DeclaredPath: "cache.go", CreatedBy: "agent"},
	} {
		if err := db.UpsertPlannedNode(sqlDB, &node); err != nil {
			t.Fatal(err)
		}
	}

	spec, err := renderBuildSpec(sqlDB, &sheet)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(spec, `class "Checkout"`) {
		t.Fatalf("approved user intent missing:\n%s", spec)
	}
	if strings.Contains(spec, "SpeculativeCache") {
		t.Fatalf("pending proposal leaked into executable work order:\n%s", spec)
	}
	if !strings.Contains(spec, "1 agent proposal(s) are awaiting user approval") {
		t.Fatalf("pending proposal was not disclosed:\n%s", spec)
	}
}
