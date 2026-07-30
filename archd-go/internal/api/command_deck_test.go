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
