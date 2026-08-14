package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	axiomruntime "axiom.local/archd/internal/runtime"
)

func TestDeleteWorkspaceErasesProposalAndBlocksLazyResurrection(t *testing.T) {
	dataDir := t.TempDir()
	eventHub := hub.New()
	server := NewServer(dataDir, eventHub, axiomruntime.NewManager(eventHub))
	sqlDB, err := server.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "deleted"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateArchitectureProposal(sqlDB, db.ArchitectureProposal{
		ID: "stale-proposal", WorkspaceID: "ws",
		Round: db.ArchitectureProposalRound{
			Coverage: "complete",
			Systems: []db.ArchitectureProposalSystem{{
				SystemKey: "core", Name: "Core", ParentRefType: "scope",
			}},
		},
	}); err != nil {
		t.Fatal(err)
	}

	response := httptest.NewRecorder()
	server.handleWorkspaceByID(response, httptest.NewRequest(http.MethodDelete, "/api/workspace/ws", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d, body = %s", response.Code, response.Body.String())
	}
	projectDir := filepath.Join(dataDir, "ws")
	if _, err := os.Stat(projectDir); !os.IsNotExist(err) {
		t.Fatalf("deleted workspace directory still exists: %v", err)
	}

	// This exact poll made Agent Setup claim a stale proposal was waiting.
	listed := httptest.NewRecorder()
	server.handleArchitectureProposals(
		listed,
		httptest.NewRequest(http.MethodGet, "/api/architecture-proposals?workspace=ws", nil),
	)
	if listed.Code != http.StatusNotFound {
		t.Fatalf("proposal poll after deletion status = %d, body = %s", listed.Code, listed.Body.String())
	}
	if _, err := os.Stat(projectDir); !os.IsNotExist(err) {
		t.Fatalf("late proposal poll recreated workspace directory: %v", err)
	}

	// An explicit reopen starts fresh. Deleted proposals cannot cross it.
	server.reviveWorkspace("ws")
	freshDB, err := server.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertWorkspace(freshDB, db.Workspace{ID: "ws", Name: "fresh"}); err != nil {
		t.Fatal(err)
	}
	proposals, err := db.ListArchitectureProposals(freshDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(proposals) != 0 {
		t.Fatalf("fresh workspace inherited proposals: %#v", proposals)
	}
	server.closeDB("ws")
}

func TestDeleteWorkspaceRejectsPathTraversal(t *testing.T) {
	dataDir := t.TempDir()
	outside := filepath.Join(filepath.Dir(dataDir), "must-survive")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(outside) })

	eventHub := hub.New()
	server := NewServer(dataDir, eventHub, axiomruntime.NewManager(eventHub))
	response := httptest.NewRecorder()
	server.handleWorkspaceByID(response, httptest.NewRequest(http.MethodDelete, "/api/workspace/../must-survive", nil))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("traversal status = %d, body = %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("path outside data directory was touched: %v", err)
	}
}
