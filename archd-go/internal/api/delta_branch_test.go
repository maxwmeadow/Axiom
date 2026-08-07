package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/delta"
	"axiom.local/archd/internal/hub"
	axiomruntime "axiom.local/archd/internal/runtime"
)

func branchDeltaServer(t *testing.T) (*Server, *httptest.ResponseRecorder) {
	t.Helper()
	eventHub := hub.New()
	server := NewServer(t.TempDir(), eventHub, axiomruntime.NewManager(eventHub))
	sqlDB, err := server.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.closeDB("ws") })
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
	return server, httptest.NewRecorder()
}

func TestDeltaGETFiltersHistoryAndSessionsByBranch(t *testing.T) {
	server, response := branchDeltaServer(t)
	sqlDB, err := server.dbFor("ws")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	for _, event := range []db.StructuralEvent{
		{WorkspaceID: "ws", RootID: "primary", Branch: "main", TS: now - 20, Kind: db.EventFileUpdated, SubjectID: "main.go", SubjectLabel: "main.go"},
		{WorkspaceID: "ws", RootID: "branch", Branch: "feature/agents", TS: now - 10, Kind: db.EventFileUpdated, SubjectID: "branch.go", SubjectLabel: "branch.go"},
	} {
		if err := db.RecordStructuralEvent(sqlDB, event); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.StartWorkSession(sqlDB, db.WorkSession{
		ID: "branch-session", WorkspaceID: "ws", RootID: "branch",
		OwnerKey: "agent", Goal: "branch work", StartedAt: now - 10,
	}); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(
		http.MethodGet, "/api/delta?workspace=ws&branch=feature%2Fagents&since=0", nil,
	)
	server.handleDelta(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("GET delta status %d: %s", response.Code, response.Body.String())
	}
	var summary delta.Summary
	if err := json.Unmarshal(response.Body.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.RootID != "branch" || summary.Branch != "feature/agents" {
		t.Fatalf("delta identity = %#v", summary)
	}
	if len(summary.Files) != 1 || summary.Files[0].ID != "branch.go" {
		t.Fatalf("branch delta leaked another root: %#v", summary.Files)
	}
	if len(summary.Sessions) != 1 || summary.Sessions[0].ID != "branch-session" {
		t.Fatalf("branch sessions = %#v", summary.Sessions)
	}
}

func TestDeltaAckAdvancesOnlySelectedRoot(t *testing.T) {
	server, response := branchDeltaServer(t)
	payload, err := json.Marshal(map[string]any{
		"workspaceId": "ws", "rootId": "primary", "branch": "main", "until": 500,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/delta/ack", bytes.NewReader(payload))
	server.handleDeltaAck(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("ack status %d: %s", response.Code, response.Body.String())
	}
	sqlDB, err := server.dbFor("ws")
	if err != nil {
		t.Fatal(err)
	}
	primary, err := db.GetDeltaReviewedAtForRoot(sqlDB, "ws", "primary")
	if err != nil {
		t.Fatal(err)
	}
	branch, err := db.GetDeltaReviewedAtForRoot(sqlDB, "ws", "branch")
	if err != nil {
		t.Fatal(err)
	}
	if primary != 500 || branch != 0 {
		t.Fatalf("watermarks after primary ack = primary:%d branch:%d", primary, branch)
	}
}

func TestWorkStartResolvesNestedCwdToItsLongestRoot(t *testing.T) {
	server, response := branchDeltaServer(t)
	payload, err := json.Marshal(map[string]any{
		"workspaceId": "ws",
		"cwd":         "C:/branch/packages/payments",
		"ownerKey":    "agent",
		"agent":       "codex",
		"goal":        "change payments",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/work/start", bytes.NewReader(payload))
	server.handleWork(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("start status %d: %s", response.Code, response.Body.String())
	}
	var session db.WorkSession
	if err := json.Unmarshal(response.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	if session.RootID != "branch" || session.Branch != "feature/agents" {
		t.Fatalf("cwd session identity = %#v", session)
	}
}

func TestAgentActionResolvesCwdBeforeSessionAttribution(t *testing.T) {
	server, response := branchDeltaServer(t)
	payload, err := json.Marshal(map[string]any{
		"workspaceId": "ws",
		"cwd":         "C:/branch/src",
		"tool":        "get_architecture",
		"kind":        "read",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/agent/action", bytes.NewReader(payload))
	server.handleAgentAction(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("action status %d: %s", response.Code, response.Body.String())
	}
	var action db.AgentAction
	if err := json.Unmarshal(response.Body.Bytes(), &action); err != nil {
		t.Fatal(err)
	}
	if action.RootID != "branch" || action.Branch != "feature/agents" {
		t.Fatalf("cwd action identity = %#v", action)
	}
}
