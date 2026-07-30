package db

import (
	"database/sql"
	"testing"
)

func workSessionTestDB(t *testing.T) *sql.DB {
	t.Helper()
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	return sqlDB
}

func TestWorkSessionsRemainOpenAcrossIndependentOwners(t *testing.T) {
	sqlDB := workSessionTestDB(t)
	first, err := StartWorkSession(sqlDB, WorkSession{
		ID: "a-1", WorkspaceID: "ws", OwnerKey: "owner-a",
		Goal: "Change auth", FocusSystemIDs: []string{"auth"},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := StartWorkSession(sqlDB, WorkSession{
		ID: "b-1", WorkspaceID: "ws", OwnerKey: "owner-b",
		Goal: "Change billing", FocusSystemIDs: []string{"billing"},
	})
	if err != nil {
		t.Fatal(err)
	}

	active, err := GetActiveWorkSessions(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 2 {
		t.Fatalf("parallel owners should both remain visible: %#v", active)
	}

	if _, err := StartWorkSession(sqlDB, WorkSession{
		ID: "a-2", WorkspaceID: "ws", OwnerKey: "owner-a",
		Goal: "Continue auth", FocusFileIDs: []string{"token-file"},
	}); err != nil {
		t.Fatal(err)
	}
	first, err = GetWorkSession(sqlDB, "ws", first.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err = GetWorkSession(sqlDB, "ws", second.ID)
	if err != nil {
		t.Fatal(err)
	}
	if first.EndedAt == 0 {
		t.Fatal("an owner's forgotten session should be closed by its next task")
	}
	if second.EndedAt != 0 {
		t.Fatal("one owner starting work must not close another agent's session")
	}
}

func TestFocusedAttributionRefusesAmbiguousParallelWork(t *testing.T) {
	sqlDB := workSessionTestDB(t)
	for _, session := range []WorkSession{
		{
			ID: "auth-work", WorkspaceID: "ws", OwnerKey: "owner-a",
			Goal: "Auth", FocusSystemIDs: []string{"auth"}, FocusFileIDs: []string{"token-file"},
		},
		{
			ID: "billing-work", WorkspaceID: "ws", OwnerKey: "owner-b",
			Goal: "Billing", FocusSystemIDs: []string{"billing"},
		},
	} {
		if _, err := StartWorkSession(sqlDB, session); err != nil {
			t.Fatal(err)
		}
	}

	if got := ActiveWorkSessionIDForEntities(sqlDB, "ws", "token-file"); got != "auth-work" {
		t.Fatalf("file scope should select auth work, got %q", got)
	}
	if got := ActiveWorkSessionIDForEntities(sqlDB, "ws", "billing"); got != "billing-work" {
		t.Fatalf("system scope should select billing work, got %q", got)
	}
	if got := ActiveWorkSessionIDForEntities(sqlDB, "ws", "unrelated"); got != "" {
		t.Fatalf("unmatched parallel work must remain unexplained, got %q", got)
	}
	if got := ActiveWorkSessionIDForEntities(sqlDB, "ws", "auth", "billing"); got != "" {
		t.Fatalf("an event touching two declared scopes is ambiguous, got %q", got)
	}
}

func TestSessionSpecificNotesAndFinishDoNotMutateAnotherAgent(t *testing.T) {
	sqlDB := workSessionTestDB(t)
	for _, session := range []WorkSession{
		{ID: "a", WorkspaceID: "ws", OwnerKey: "owner-a", Goal: "A"},
		{ID: "b", WorkspaceID: "ws", OwnerKey: "owner-b", Goal: "B"},
	} {
		if _, err := StartWorkSession(sqlDB, session); err != nil {
			t.Fatal(err)
		}
	}
	if err := AppendWorkSessionNoteByID(sqlDB, "ws", "a", "decision A"); err != nil {
		t.Fatal(err)
	}
	if err := FinishWorkSessionByID(sqlDB, "ws", "a", "done A"); err != nil {
		t.Fatal(err)
	}
	a, _ := GetWorkSession(sqlDB, "ws", "a")
	b, _ := GetWorkSession(sqlDB, "ws", "b")
	if len(a.Notes) != 1 || a.Summary != "done A" || a.EndedAt == 0 {
		t.Fatalf("target session was not updated: %#v", a)
	}
	if len(b.Notes) != 0 || b.Summary != "" || b.EndedAt != 0 {
		t.Fatalf("another agent's session was mutated: %#v", b)
	}
}

func TestUpdateCollapseNeverMergesDifferentWorkSessions(t *testing.T) {
	sqlDB := workSessionTestDB(t)
	for _, sessionID := range []string{"work-a", "work-b"} {
		if err := RecordStructuralEvent(sqlDB, StructuralEvent{
			WorkspaceID: "ws",
			TS:          100,
			Actor:       "agent",
			Kind:        EventFileUpdated,
			SubjectID:   "shared-file",
			SessionID:   sessionID,
		}); err != nil {
			t.Fatal(err)
		}
	}
	events, err := GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("parallel agents' saves must not collapse into one attribution: %#v", events)
	}
}
