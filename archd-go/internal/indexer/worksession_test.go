package indexer

import (
	"path/filepath"
	"testing"

	"axiom.local/archd/internal/db"
)

// Narration is what turns "Handlers now depends on Record" into something a
// person can act on. These tests prove the agent's account actually reaches
// the changes it explains.

func TestChangesAreAttributedToTheDeclaredWork(t *testing.T) {
	sqlDB, root, eventHub := journalFixture(t)

	session, err := db.StartWorkSession(sqlDB, db.WorkSession{
		ID: "s1", WorkspaceID: "ws", Agent: "antigravity",
		Goal: "Add write-through caching to storage",
	})
	if err != nil {
		t.Fatal(err)
	}

	writeLivingFixture(t, filepath.Join(root.Path, "cache.py"), "class Cache:\n    def put(self):\n        return 1\n")
	if err := ReindexFile(sqlDB, eventHub, root, filepath.Join(root.Path, "cache.py")); err != nil {
		t.Fatal(err)
	}

	events, err := db.GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 {
		t.Fatal("the change should have been journaled")
	}
	for _, ev := range events {
		if ev.SessionID != session.ID {
			t.Fatalf("every change during declared work belongs to it: %+v", ev)
		}
	}

	summary := journalSummary(t, sqlDB, 0)
	if summary.Files[0].SessionID != session.ID {
		t.Fatalf("the delta lost the session link: %+v", summary.Files[0])
	}
}

func TestWorkDoneWithoutNarrationIsUnexplained(t *testing.T) {
	sqlDB, root, eventHub := journalFixture(t)
	writeLivingFixture(t, filepath.Join(root.Path, "quiet.py"), "def quiet():\n    return 1\n")
	if err := ReindexFile(sqlDB, eventHub, root, filepath.Join(root.Path, "quiet.py")); err != nil {
		t.Fatal(err)
	}

	summary := journalSummary(t, sqlDB, 0)
	if summary.Files[0].SessionID != "" {
		t.Fatalf("no session was declared, so nothing should claim this change: %+v", summary.Files[0])
	}
}

func TestParallelWorkUsesDeclaredScopeInsteadOfNewestSession(t *testing.T) {
	sqlDB, _, _ := journalFixture(t)
	for _, session := range []db.WorkSession{
		{
			ID: "auth", WorkspaceID: "ws", OwnerKey: "agent-a",
			Goal: "Change auth", FocusFileIDs: []string{"auth-file"},
		},
		{
			ID: "billing", WorkspaceID: "ws", OwnerKey: "agent-b",
			Goal: "Change billing", FocusSystemIDs: []string{"billing-system"},
		},
	} {
		if _, err := db.StartWorkSession(sqlDB, session); err != nil {
			t.Fatal(err)
		}
	}

	recordEvent(sqlDB, db.StructuralEvent{
		WorkspaceID: "ws",
		Kind:        db.EventFileUpdated,
		SubjectID:   "auth-file",
		Detail:      `{"systemId":"auth-system"}`,
	})
	recordEvent(sqlDB, db.StructuralEvent{
		WorkspaceID: "ws",
		Kind:        db.EventFileUpdated,
		SubjectID:   "unknown-file",
		Detail:      `{"systemId":"unknown-system"}`,
	})
	events, err := db.GetStructuralEvents(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("expected two events, got %#v", events)
	}
	if events[0].SessionID != "auth" {
		t.Fatalf("declared file scope should win over newest session: %#v", events[0])
	}
	if events[1].SessionID != "" {
		t.Fatalf("unmatched parallel work must be unexplained: %#v", events[1])
	}
}

func TestNotesAndSummaryAreRecordedOnTheSession(t *testing.T) {
	sqlDB, _, _ := journalFixture(t)
	if _, err := db.StartWorkSession(sqlDB, db.WorkSession{
		ID: "s1", WorkspaceID: "ws", Goal: "Refactor auth",
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.AppendWorkSessionNote(sqlDB, "ws", "moved token parsing out of the handler"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.FinishWorkSession(sqlDB, "ws", "auth now goes through one entry point"); err != nil {
		t.Fatal(err)
	}

	sessions, err := db.GetWorkSessions(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 {
		t.Fatalf("expected one session, got %+v", sessions)
	}
	if len(sessions[0].Notes) != 1 || sessions[0].Notes[0].Text == "" {
		t.Fatalf("the running note was lost: %+v", sessions[0].Notes)
	}
	if sessions[0].Summary != "auth now goes through one entry point" {
		t.Fatalf("the closing summary was lost: %q", sessions[0].Summary)
	}
	if sessions[0].EndedAt == 0 {
		t.Fatal("a finished session must be closed")
	}
}

func TestStartingWorkClosesAForgottenSession(t *testing.T) {
	sqlDB, _, _ := journalFixture(t)
	for _, goal := range []string{"first task", "second task"} {
		if _, err := db.StartWorkSession(sqlDB, db.WorkSession{
			ID: goal, WorkspaceID: "ws", Goal: goal,
		}); err != nil {
			t.Fatal(err)
		}
	}
	// An agent that crashes mid-task must not block narration forever.
	if id := db.ActiveWorkSessionID(sqlDB, "ws"); id != "second task" {
		t.Fatalf("the newest declaration should be active, got %q", id)
	}
	sessions, err := db.GetWorkSessions(sqlDB, "ws", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("both sessions belong in the window: %+v", sessions)
	}
	if sessions[0].EndedAt == 0 {
		t.Fatal("the abandoned session should have been closed out")
	}
}

func TestNotingWithoutDeclaringWorkFails(t *testing.T) {
	sqlDB, _, _ := journalFixture(t)
	if err := db.AppendWorkSessionNote(sqlDB, "ws", "orphan note"); err == nil {
		t.Fatal("a note with no declared work has nothing to attach to")
	}
}
