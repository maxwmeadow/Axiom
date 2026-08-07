package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"axiom.local/archd/internal/collision"
	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	axiomruntime "axiom.local/archd/internal/runtime"
)

func TestCollisionsSurfaceUnmergedSemanticOverlapAfterDeltaReview(t *testing.T) {
	primaryPath := filepath.Join(t.TempDir(), "primary")
	leftPath := filepath.Join(t.TempDir(), "left")
	rightPath := filepath.Join(t.TempDir(), "right")
	if err := os.MkdirAll(primaryPath, 0o755); err != nil {
		t.Fatal(err)
	}
	runWorktreeGit(t, primaryPath, "init", "-b", "main")
	runWorktreeGit(t, primaryPath, "config", "user.email", "axiom@example.test")
	runWorktreeGit(t, primaryPath, "config", "user.name", "Axiom Test")
	if err := os.MkdirAll(filepath.Join(primaryPath, "payments"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(primaryPath, "payments", "base.go"), []byte("package payments\n"), 0o644,
	); err != nil {
		t.Fatal(err)
	}
	runWorktreeGit(t, primaryPath, "add", ".")
	runWorktreeGit(t, primaryPath, "commit", "-m", "base")
	runWorktreeGit(t, primaryPath, "worktree", "add", "-b", "feature/left", leftPath, "HEAD")
	runWorktreeGit(t, primaryPath, "worktree", "add", "-b", "feature/right", rightPath, "HEAD")
	if err := os.WriteFile(
		filepath.Join(leftPath, "payments", "left.go"), []byte("package payments\n"), 0o644,
	); err != nil {
		t.Fatal(err)
	}
	runWorktreeGit(t, leftPath, "add", ".")
	runWorktreeGit(t, leftPath, "commit", "-m", "left payment")
	if err := os.WriteFile(
		filepath.Join(rightPath, "payments", "right.go"), []byte("package payments\n"), 0o644,
	); err != nil {
		t.Fatal(err)
	}

	eventHub := hub.New()
	server := NewServer(t.TempDir(), eventHub, axiomruntime.NewManager(eventHub))
	sqlDB, err := server.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.closeDB("ws") })
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "collision"}); err != nil {
		t.Fatal(err)
	}
	roots := []db.Root{
		{ID: "primary", WorkspaceID: "ws", Path: primaryPath, Branch: "main", HeadCommit: strings.TrimSpace(runWorktreeGit(t, primaryPath, "rev-parse", "HEAD")), IsPrimary: true},
		{ID: "left", WorkspaceID: "ws", Path: leftPath, Branch: "feature/left", HeadCommit: strings.TrimSpace(runWorktreeGit(t, leftPath, "rev-parse", "HEAD"))},
		{ID: "right", WorkspaceID: "ws", Path: rightPath, Branch: "feature/right", HeadCommit: strings.TrimSpace(runWorktreeGit(t, rightPath, "rev-parse", "HEAD"))},
	}
	for _, root := range roots {
		if err := db.UpsertRoot(sqlDB, root); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.UpsertSystem(sqlDB, db.System{ID: "payments", WorkspaceID: "ws", Name: "Payments"}); err != nil {
		t.Fatal(err)
	}
	systemID := "payments"
	for _, file := range []db.File{
		{ID: "left-file", RootID: "left", Path: filepath.Join(leftPath, "payments", "left.go"), RelPath: "payments/left.go", SystemID: &systemID},
		{ID: "right-file", RootID: "right", Path: filepath.Join(rightPath, "payments", "right.go"), RelPath: "payments/right.go", SystemID: &systemID},
	} {
		if err := db.UpsertFile(sqlDB, file); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UnixMilli()
	for _, event := range []db.StructuralEvent{
		{WorkspaceID: "ws", RootID: "left", Branch: "feature/left", TS: now - 20, Kind: db.EventFileCreated, SubjectID: "left-file", SubjectLabel: "payments/left.go", Detail: `{"relPath":"payments/left.go","systemId":"payments","systemName":"Payments"}`},
		{WorkspaceID: "ws", RootID: "right", Branch: "feature/right", TS: now - 10, Kind: db.EventFileCreated, SubjectID: "right-file", SubjectLabel: "payments/right.go", Detail: `{"relPath":"payments/right.go","systemId":"payments","systemName":"Payments"}`},
	} {
		if err := db.RecordStructuralEvent(sqlDB, event); err != nil {
			t.Fatal(err)
		}
		if err := db.SetDeltaReviewedAtForRoot(sqlDB, "ws", event.RootID, now); err != nil {
			t.Fatal(err)
		}
	}
	for _, session := range []db.WorkSession{
		{ID: "left-work", WorkspaceID: "ws", RootID: "left", OwnerKey: "left-agent", Agent: "codex", Goal: "left payment"},
		{ID: "right-work", WorkspaceID: "ws", RootID: "right", OwnerKey: "right-agent", Agent: "claude", Goal: "right payment"},
	} {
		if _, err := db.StartWorkSession(sqlDB, session); err != nil {
			t.Fatal(err)
		}
	}

	request := httptest.NewRequest(http.MethodGet, "/api/collisions?workspace=ws", nil)
	response := httptest.NewRecorder()
	server.handleCollisions(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("collision status %d: %s", response.Code, response.Body.String())
	}
	var snapshot collision.Snapshot
	if err := json.Unmarshal(response.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Branches) != 3 {
		t.Fatalf("branches = %#v", snapshot.Branches)
	}
	if len(snapshot.Branches[1].ActiveWork) != 1 || len(snapshot.Branches[2].ActiveWork) != 1 {
		t.Fatalf("branch agent attribution = %#v", snapshot.Branches)
	}
	if len(snapshot.Collisions) != 1 || snapshot.Collisions[0].SystemID != "payments" {
		t.Fatalf("collisions = %#v", snapshot.Collisions)
	}
	branches := snapshot.Collisions[0].Branches
	if len(branches) != 2 || branches[0].Branch != "feature/left" || branches[1].Branch != "feature/right" {
		t.Fatalf("collision branches = %#v", branches)
	}
	for _, branch := range branches {
		if len(branch.Files) != 1 || len(branch.Claims) != 1 {
			t.Fatalf("branch evidence = %#v", branch)
		}
	}
}
