package db

import "testing"

func TestAgentPlansRequireApprovalBeforeReconciliation(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "increment"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}

	userPlan := PlannedNode{ID: "user-plan", SheetID: sheet.ID, WorkspaceID: "ws", Name: "User plan"}
	agentPlan := PlannedNode{ID: "agent-plan", SheetID: sheet.ID, WorkspaceID: "ws", Name: "Agent plan", CreatedBy: "agent"}
	if err := UpsertPlannedNode(sqlDB, &userPlan); err != nil {
		t.Fatal(err)
	}
	if err := UpsertPlannedNode(sqlDB, &agentPlan); err != nil {
		t.Fatal(err)
	}
	if userPlan.ApprovalStatus != "approved" {
		t.Fatalf("user-authored intent should be approved immediately: %#v", userPlan)
	}
	if agentPlan.ApprovalStatus != "pending" {
		t.Fatalf("agent proposal should await the user: %#v", agentPlan)
	}

	open, err := GetOpenPlannedNodes(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(open) != 1 || open[0].ID != userPlan.ID {
		t.Fatalf("pending agent plan entered reconciliation: %#v", open)
	}

	approved, err := SetPlannedApproval(sqlDB, agentPlan.ID, "approved")
	if err != nil {
		t.Fatal(err)
	}
	if approved.ApprovalStatus != "approved" {
		t.Fatalf("approval did not persist: %#v", approved)
	}
	open, err = GetOpenPlannedNodes(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(open) != 2 {
		t.Fatalf("approved proposal did not enter reconciliation: %#v", open)
	}
}

func TestRejectedAgentPlanCannotBeApprovedLater(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "increment"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}
	node := PlannedNode{ID: "proposal", SheetID: sheet.ID, WorkspaceID: "ws", Name: "Proposal", CreatedBy: "agent"}
	if err := UpsertPlannedNode(sqlDB, &node); err != nil {
		t.Fatal(err)
	}
	if _, err := SetPlannedApproval(sqlDB, node.ID, "rejected"); err != nil {
		t.Fatal(err)
	}
	if _, err := SetPlannedApproval(sqlDB, node.ID, "approved"); err == nil {
		t.Fatal("a final rejection must not be silently reversed")
	}
}

func TestCanvasDispatchPersistsImmutableBuildSpec(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	message := CanvasMessage{
		WorkspaceID:  "ws",
		Note:         "Build the approved increment",
		SheetContext: `{"sheet":"increment"}`,
		BuildSpec:    "# Build spec\n- approved work",
	}
	if err := EnqueueCanvasMessage(sqlDB, &message); err != nil {
		t.Fatal(err)
	}
	delivered, err := DrainCanvasMessages(sqlDB, "ws", "test-agent")
	if err != nil {
		t.Fatal(err)
	}
	if len(delivered) != 1 || delivered[0].BuildSpec != message.BuildSpec {
		t.Fatalf("dispatched work order changed or disappeared: %#v", delivered)
	}
}
