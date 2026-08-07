package db

import (
	"database/sql"
	"testing"
)

func branchHistoryTestDB(t *testing.T) *sql.DB {
	t.Helper()
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "branches"}); err != nil {
		t.Fatal(err)
	}
	for _, root := range []Root{
		{ID: "primary", WorkspaceID: "ws", Path: "C:/primary", Branch: "main", IsPrimary: true},
		{ID: "branch", WorkspaceID: "ws", Path: "C:/branch", Branch: "feature/agents"},
	} {
		if err := UpsertRoot(sqlDB, root); err != nil {
			t.Fatal(err)
		}
	}
	return sqlDB
}

func TestStructuralUpdateCollapseIsolatedByRootAndBranch(t *testing.T) {
	sqlDB := branchHistoryTestDB(t)
	for _, event := range []StructuralEvent{
		{WorkspaceID: "ws", RootID: "primary", Branch: "main", TS: 100, Kind: EventFileUpdated, SubjectID: "same"},
		{WorkspaceID: "ws", RootID: "branch", Branch: "feature/agents", TS: 110, Kind: EventFileUpdated, SubjectID: "same"},
		{WorkspaceID: "ws", RootID: "primary", Branch: "main", TS: 120, Kind: EventFileUpdated, SubjectID: "same"},
	} {
		if err := RecordStructuralEvent(sqlDB, event); err != nil {
			t.Fatal(err)
		}
	}
	events, err := GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("branch updates collapsed together: %#v", events)
	}
	if events[0].RootID != "branch" || events[0].Count != 1 {
		t.Fatalf("branch event = %#v", events[0])
	}
	if events[1].RootID != "primary" || events[1].Count != 2 {
		t.Fatalf("primary event = %#v", events[1])
	}
}

func TestSessionsAndActionsKeepBranchAttribution(t *testing.T) {
	sqlDB := branchHistoryTestDB(t)
	for _, session := range []WorkSession{
		{ID: "main-work", WorkspaceID: "ws", RootID: "primary", OwnerKey: "main-owner", Goal: "main", FocusSystemIDs: []string{"payments"}},
		{ID: "branch-work", WorkspaceID: "ws", RootID: "branch", OwnerKey: "branch-owner", Goal: "branch", FocusSystemIDs: []string{"payments"}},
	} {
		if _, err := StartWorkSession(sqlDB, session); err != nil {
			t.Fatal(err)
		}
	}
	if got := ActiveWorkSessionIDForRootEntities(sqlDB, "ws", "primary", "payments"); got != "main-work" {
		t.Fatalf("primary attribution = %q", got)
	}
	if got := ActiveWorkSessionIDForRootEntities(sqlDB, "ws", "branch", "payments"); got != "branch-work" {
		t.Fatalf("branch attribution = %q", got)
	}

	action, err := RecordAgentAction(sqlDB, AgentAction{
		WorkspaceID: "ws",
		SessionID:   "branch-work",
		Tool:        "query_architecture",
		Kind:        ActionRead,
	})
	if err != nil {
		t.Fatal(err)
	}
	if action.RootID != "branch" || action.Branch != "feature/agents" {
		t.Fatalf("action did not inherit its session identity: %#v", action)
	}

	branchRoot := Root{
		ID: "branch", WorkspaceID: "ws", Path: "C:/branch",
		Branch: "feature/renamed", HeadCommit: "new-head",
	}
	if err := UpsertRoot(sqlDB, branchRoot); err != nil {
		t.Fatal(err)
	}
	actions, err := GetAgentActions(sqlDB, "ws", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(actions) != 1 || actions[0].Branch != "feature/agents" {
		t.Fatalf("historical action branch drifted with root metadata: %#v", actions)
	}
}

func TestImplicitSessionAttributionNeverCrossesRoots(t *testing.T) {
	sqlDB := branchHistoryTestDB(t)
	if _, err := StartWorkSession(sqlDB, WorkSession{
		ID: "branch-only", WorkspaceID: "ws", RootID: "branch",
		OwnerKey: "branch-owner", Goal: "branch",
	}); err != nil {
		t.Fatal(err)
	}
	if got := ActiveWorkSessionIDForRootEntities(sqlDB, "ws", "primary", "unfocused"); got != "" {
		t.Fatalf("primary event attributed to branch session %q", got)
	}
}

func TestNewUnscopedHistoryStampsPrimaryRoot(t *testing.T) {
	sqlDB := branchHistoryTestDB(t)
	if err := RecordStructuralEvent(sqlDB, StructuralEvent{
		WorkspaceID: "ws", TS: 10, Kind: EventFileCreated, SubjectID: "file",
	}); err != nil {
		t.Fatal(err)
	}
	session, err := StartWorkSession(sqlDB, WorkSession{
		ID: "legacy-caller", WorkspaceID: "ws", OwnerKey: "legacy", Goal: "work",
	})
	if err != nil {
		t.Fatal(err)
	}
	action, err := RecordAgentAction(sqlDB, AgentAction{
		WorkspaceID: "ws", Tool: "query_architecture", Kind: ActionRead,
	})
	if err != nil {
		t.Fatal(err)
	}
	events, err := GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].RootID != "primary" || events[0].Branch != "main" {
		t.Fatalf("unscoped event identity = %#v", events)
	}
	if session.RootID != "primary" || session.Branch != "main" {
		t.Fatalf("unscoped session identity = %#v", session)
	}
	if action.RootID != "primary" || action.Branch != "main" {
		t.Fatalf("unscoped action identity = %#v", action)
	}
}

func TestDeltaWatermarksAreIndependentByRoot(t *testing.T) {
	sqlDB := branchHistoryTestDB(t)
	if _, err := sqlDB.Exec(`UPDATE workspaces SET delta_reviewed_at=50 WHERE id='ws'`); err != nil {
		t.Fatal(err)
	}
	primary, err := GetDeltaReviewedAtForRoot(sqlDB, "ws", "primary")
	if err != nil || primary != 50 {
		t.Fatalf("primary legacy watermark = %d, err = %v", primary, err)
	}
	branch, err := GetDeltaReviewedAtForRoot(sqlDB, "ws", "branch")
	if err != nil || branch != 0 {
		t.Fatalf("new branch inherited workspace watermark = %d, err = %v", branch, err)
	}
	if err := SetDeltaReviewedAtForRoot(sqlDB, "ws", "primary", 40); err != nil {
		t.Fatal(err)
	}
	primary, _ = GetDeltaReviewedAtForRoot(sqlDB, "ws", "primary")
	if primary != 50 {
		t.Fatalf("late primary acknowledgement moved legacy watermark backwards to %d", primary)
	}
	if err := SetDeltaReviewedAtForRoot(sqlDB, "ws", "primary", 75); err != nil {
		t.Fatal(err)
	}
	if err := SetDeltaReviewedAtForRoot(sqlDB, "ws", "branch", 100); err != nil {
		t.Fatal(err)
	}
	if err := SetDeltaReviewedAtForRoot(sqlDB, "ws", "branch", 90); err != nil {
		t.Fatal(err)
	}
	primary, _ = GetDeltaReviewedAtForRoot(sqlDB, "ws", "primary")
	branch, _ = GetDeltaReviewedAtForRoot(sqlDB, "ws", "branch")
	if primary != 75 || branch != 100 {
		t.Fatalf("independent watermarks = primary:%d branch:%d", primary, branch)
	}
	var legacy int64
	if err := sqlDB.QueryRow(`SELECT delta_reviewed_at FROM workspaces WHERE id='ws'`).Scan(&legacy); err != nil {
		t.Fatal(err)
	}
	if legacy != 50 {
		t.Fatalf("per-root acknowledgement rewrote legacy workspace watermark to %d", legacy)
	}
}

func TestRootDeltaSnapshotsAreBranchIsolatedWithLegacyPrimaryFallback(t *testing.T) {
	sqlDB := branchHistoryTestDB(t)
	if err := SaveDeltaSnapshot(sqlDB, "ws", 50, `{"legacy":true}`); err != nil {
		t.Fatal(err)
	}
	legacy, err := GetDeltaSnapshotForRoot(sqlDB, "ws", "primary", "main", 50)
	if err != nil || legacy != `{"legacy":true}` {
		t.Fatalf("primary legacy snapshot = %q, err = %v", legacy, err)
	}
	if err := SaveDeltaSnapshotForRoot(
		sqlDB, "ws", "branch", "feature/agents", 100, `{"branch":"agents"}`,
	); err != nil {
		t.Fatal(err)
	}
	if err := SaveDeltaSnapshotForRoot(
		sqlDB, "ws", "branch", "feature/renamed", 100, `{"branch":"renamed"}`,
	); err != nil {
		t.Fatal(err)
	}
	for branch, want := range map[string]string{
		"feature/agents":  `{"branch":"agents"}`,
		"feature/renamed": `{"branch":"renamed"}`,
	} {
		got, getErr := GetDeltaSnapshotForRoot(sqlDB, "ws", "branch", branch, 100)
		if getErr != nil || got != want {
			t.Fatalf("snapshot for %s = %q, err = %v", branch, got, getErr)
		}
	}
}
