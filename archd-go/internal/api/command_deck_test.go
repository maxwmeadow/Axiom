package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	axiomruntime "axiom.local/archd/internal/runtime"
)

func TestCommandDeckSummarizesDurableProjectStateWithoutRegisteringIt(t *testing.T) {
	dataDir := t.TempDir()
	sqlDB, err := db.Open(filepath.Join(dataDir, "ws"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartWorkSession(sqlDB, db.WorkSession{
		ID: "work", WorkspaceID: "ws", OwnerKey: "agent-a",
		Agent: "claude", Goal: "Build auth", FocusSystemIDs: []string{"auth"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordStructuralEvent(sqlDB, db.StructuralEvent{
		WorkspaceID: "ws", TS: time.Now().UnixMilli(), Actor: "agent",
		Kind: db.EventFileCreated, SubjectID: "new-file", SubjectLabel: "new.go",
	}); err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}

	eventHub := hub.New()
	server := NewServer(dataDir, eventHub, axiomruntime.NewManager(eventHub))
	t.Cleanup(func() { server.closeDB("ws") })
	request := httptest.NewRequest(http.MethodGet, "/api/command-deck?workspace=ws", nil)
	response := httptest.NewRecorder()
	server.handleCommandDeck(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var status commandDeckStatus
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.Indexed || len(status.ActiveWork) != 1 {
		t.Fatalf("durable active work missing from dashboard: %#v", status)
	}
	if status.UnreviewedClaims != 1 || status.Unexplained != 1 || status.Unexpected != 1 {
		t.Fatalf("unreviewed unexplained change missing: %#v", status)
	}
}

func TestCommandDeckKeepsBranchBriefingsIndependent(t *testing.T) {
	dataDir := t.TempDir()
	sqlDB, err := db.Open(filepath.Join(dataDir, "ws"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "branches"}); err != nil {
		t.Fatal(err)
	}
	for _, root := range []db.Root{
		{ID: "primary", WorkspaceID: "ws", Path: "C:/primary", Branch: "main", IsPrimary: true},
		{ID: "branch", WorkspaceID: "ws", Path: "C:/branch", Branch: "feature/agents"},
	} {
		if err := db.UpsertRoot(sqlDB, root); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UnixMilli()
	for _, event := range []db.StructuralEvent{
		{WorkspaceID: "ws", RootID: "primary", Branch: "main", TS: now - 20, Actor: "agent", Kind: db.EventFileCreated, SubjectID: "main-file", SubjectLabel: "main.go"},
		{WorkspaceID: "ws", RootID: "branch", Branch: "feature/agents", TS: now - 10, Actor: "agent", Kind: db.EventFileCreated, SubjectID: "branch-file", SubjectLabel: "branch.go"},
	} {
		if err := db.RecordStructuralEvent(sqlDB, event); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.SetDeltaReviewedAtForRoot(sqlDB, "ws", "primary", now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartWorkSession(sqlDB, db.WorkSession{
		ID: "branch-work", WorkspaceID: "ws", RootID: "branch",
		OwnerKey: "agent", Agent: "codex", Goal: "branch work",
	}); err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}

	eventHub := hub.New()
	server := NewServer(dataDir, eventHub, axiomruntime.NewManager(eventHub))
	t.Cleanup(func() { server.closeDB("ws") })
	request := httptest.NewRequest(http.MethodGet, "/api/command-deck?workspace=ws", nil)
	response := httptest.NewRecorder()
	server.handleCommandDeck(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var status commandDeckStatus
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if len(status.Branches) != 2 {
		t.Fatalf("branch briefings = %#v", status.Branches)
	}
	if status.Branches[0].Branch != "main" || status.Branches[0].UnreviewedClaims != 0 {
		t.Fatalf("primary briefing = %#v", status.Branches[0])
	}
	if status.Branches[1].Branch != "feature/agents" || status.Branches[1].UnreviewedClaims != 1 || len(status.Branches[1].ActiveWork) != 1 {
		t.Fatalf("agent branch briefing = %#v", status.Branches[1])
	}
	if status.UnreviewedClaims != 1 || len(status.ActiveWork) != 1 {
		t.Fatalf("legacy aggregate did not summarize branches: %#v", status)
	}
}
