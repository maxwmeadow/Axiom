package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	axiomruntime "axiom.local/archd/internal/runtime"
)

func TestWorkspaceScopeReportsLegacyIndexedProject(t *testing.T) {
	dataDir := t.TempDir()
	projectDir := filepath.Join(dataDir, "ws")
	sqlDB, err := db.Open(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "legacy"}); err != nil {
		t.Fatal(err)
	}
	root := db.Root{
		ID: "root", WorkspaceID: "ws", Path: filepath.Join(t.TempDir(), "project"),
		IgnoredPaths: []string{"generated/**"},
	}
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	if err := db.MarkRootIndexed(sqlDB, root.ID, 3); err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}

	eventHub := hub.New()
	server := NewServer(dataDir, eventHub, axiomruntime.NewManager(eventHub))
	t.Cleanup(func() { server.closeDB("ws") })
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/workspace-scope/ws?rootPath="+root.Path,
		nil,
	)
	response := httptest.NewRecorder()
	server.handleWorkspaceScope(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var status struct {
		Indexed                    bool     `json:"indexed"`
		IgnoredPaths               []string `json:"ignoredPaths"`
		SourceBoundariesReviewedAt *int64   `json:"sourceBoundariesReviewedAt"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.Indexed {
		t.Fatal("legacy indexed project was not detected")
	}
	if len(status.IgnoredPaths) != 1 || status.IgnoredPaths[0] != "generated/**" {
		t.Fatalf("ignored paths = %#v", status.IgnoredPaths)
	}
	if status.SourceBoundariesReviewedAt != nil {
		t.Fatal("legacy fixture should not already have an explicit review timestamp")
	}
}
