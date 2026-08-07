package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/gitworktree"
	"axiom.local/archd/internal/hub"
	"axiom.local/archd/internal/runtime"
)

func TestSyncWorkspaceWorktreesAddsRefreshesAndRemovesLiveRoots(t *testing.T) {
	dataDir := t.TempDir()
	eventHub := hub.New()
	server := NewServer(dataDir, eventHub, runtime.NewManager(eventHub))
	server.worktreeRefresh = 0
	sqlDB, err := server.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.closeDB("ws") })
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "worktrees"}); err != nil {
		t.Fatal(err)
	}

	primaryPath := filepath.Join(t.TempDir(), "primary")
	branchPath := filepath.Join(t.TempDir(), "branch")
	thirdPath := filepath.Join(t.TempDir(), "third")
	for _, path := range []string{primaryPath, branchPath, thirdPath} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	initial := []gitworktree.Worktree{
		{Path: primaryPath, Branch: "main", HeadCommit: "aaa", Primary: true},
		{Path: branchPath, Branch: "feature/one", HeadCommit: "bbb"},
	}
	if _, err := server.syncWorkspaceWorktrees(
		sqlDB, "ws", primaryPath, initial, rootOpenOptions{}, false, false,
	); err != nil {
		t.Fatal(err)
	}

	roots, err := db.GetActiveRoots(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 2 || !roots[0].IsPrimary || roots[0].Path != primaryPath {
		t.Fatalf("initial roots = %#v", roots)
	}
	branchID := roots[1].ID
	for _, root := range roots {
		if err := db.UpsertFile(sqlDB, db.File{
			ID: root.ID + "-file", RootID: root.ID,
			Path: filepath.Join(root.Path, "file.go"), RelPath: "file.go",
		}); err != nil {
			t.Fatal(err)
		}
	}

	refreshed := []gitworktree.Worktree{
		{Path: primaryPath, Branch: "main", HeadCommit: "new-head", Primary: true},
		{Path: thirdPath, Branch: "feature/three", HeadCommit: "ccc"},
	}
	if _, err := server.syncWorkspaceWorktrees(
		sqlDB, "ws", primaryPath, refreshed, rootOpenOptions{}, false, false,
	); err != nil {
		t.Fatal(err)
	}

	active, err := db.GetActiveRoots(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 2 || active[0].HeadCommit != "new-head" || active[1].Branch != "feature/three" {
		t.Fatalf("refreshed roots = %#v", active)
	}
	removedFiles, err := db.GetFilesByRoot(sqlDB, branchID)
	if err != nil || len(removedFiles) != 0 {
		t.Fatalf("removed worktree graph remains: files=%#v err=%v", removedFiles, err)
	}
	server.mu.RLock()
	watcherCount := len(server.watchers)
	_, removedWatcher := server.watchers[branchID]
	server.mu.RUnlock()
	if watcherCount != 2 || removedWatcher {
		t.Fatalf("watchers = %d, removed watcher present = %t", watcherCount, removedWatcher)
	}
}

func TestDiscoverInitialWorktreesFallsBackForNonGitFolder(t *testing.T) {
	eventHub := hub.New()
	server := NewServer(t.TempDir(), eventHub, runtime.NewManager(eventHub))
	server.discoverWorktrees = func(string) ([]gitworktree.Worktree, error) {
		return nil, fmt.Errorf("not a git repository")
	}
	path := filepath.Join(t.TempDir(), "plain-project")
	worktrees, isGit := server.discoverInitialWorktrees(path)
	if isGit || len(worktrees) != 1 || !worktrees[0].Primary || worktrees[0].Path != filepath.Clean(path) {
		t.Fatalf("fallback worktrees = %#v, isGit = %t", worktrees, isGit)
	}
}

func TestIgnoredPathsFollowEachLinkedWorktree(t *testing.T) {
	patterns := []string{
		"C:/code/Axiom/generated/**",
		"relative/vendor/**",
	}
	translated := ignoredPathsForWorktree(patterns, "C:/code/Axiom", "D:/agents/Axiom-feature")
	if len(translated) != 2 || translated[0] != "D:/agents/Axiom-feature/generated/**" || translated[1] != patterns[1] {
		t.Fatalf("translated ignored paths = %#v", translated)
	}
}

func TestRootPathNormalizationMatchesHostFilesystemSemantics(t *testing.T) {
	windowsUpper := normalizedRootPathForOS(`C:\Code\Axiom-Agent`, "windows")
	windowsLower := normalizedRootPathForOS(`c:/code/axiom-agent`, "windows")
	if windowsUpper != windowsLower {
		t.Fatalf("Windows paths should compare case-insensitively: %q != %q", windowsUpper, windowsLower)
	}
	linuxUpper := normalizedRootPathForOS(`/code/Axiom-Agent`, "linux")
	linuxLower := normalizedRootPathForOS(`/code/axiom-agent`, "linux")
	if linuxUpper == linuxLower {
		t.Fatalf("case-sensitive hosts must keep distinct worktrees distinct: %q == %q", linuxUpper, linuxLower)
	}
}

func runWorktreeGit(t *testing.T, directory string, args ...string) string {
	t.Helper()
	commandArgs := append([]string{"-C", directory}, args...)
	command := exec.Command("git", commandArgs...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func waitForWorktreeTest(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}

func TestOpenWorkspaceDiscoversIndexesAndWatchesNewGitWorktrees(t *testing.T) {
	projectParent := t.TempDir()
	primaryPath := filepath.Join(projectParent, "primary")
	if err := os.MkdirAll(primaryPath, 0o755); err != nil {
		t.Fatal(err)
	}
	runWorktreeGit(t, primaryPath, "init")
	runWorktreeGit(t, primaryPath, "config", "user.email", "axiom-test@example.com")
	runWorktreeGit(t, primaryPath, "config", "user.name", "Axiom Test")
	if err := os.WriteFile(
		filepath.Join(primaryPath, "base.go"),
		[]byte("package sample\n\nfunc Base() {}\n"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	runWorktreeGit(t, primaryPath, "add", "base.go")
	runWorktreeGit(t, primaryPath, "commit", "-m", "baseline")

	firstAgentPath := filepath.Join(projectParent, "agent-one")
	runWorktreeGit(t, primaryPath, "worktree", "add", "-b", "agent-one", firstAgentPath)

	eventHub := hub.New()
	server := NewServer(t.TempDir(), eventHub, runtime.NewManager(eventHub))
	// Keep the fallback far beyond the test deadline: the new worktree must be
	// discovered from Git metadata, not from a hot subprocess polling loop.
	server.worktreeRefresh = time.Hour
	t.Cleanup(func() { server.closeDB("ws") })
	payload, err := json.Marshal(openWorkspaceReq{
		WorkspaceID: "ws",
		Name:        "git worktrees",
		RootPath:    primaryPath,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/workspace", bytes.NewReader(payload))
	response := httptest.NewRecorder()
	server.handleWorkspace(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("open workspace status = %d, body = %s", response.Code, response.Body.String())
	}
	sqlDB, err := server.dbFor("ws")
	if err != nil {
		t.Fatal(err)
	}
	waitForWorktreeTest(t, "two indexed worktrees with live watchers", func() bool {
		roots, err := db.GetActiveRoots(sqlDB, "ws")
		if err != nil || len(roots) != 2 {
			return false
		}
		for _, root := range roots {
			if root.IndexedAt == nil || *root.IndexedAt == 0 {
				return false
			}
		}
		server.mu.RLock()
		watcherCount := len(server.watchers)
		server.mu.RUnlock()
		return watcherCount == 2
	})

	secondAgentPath := filepath.Join(projectParent, "agent-two")
	runWorktreeGit(t, primaryPath, "worktree", "add", "-b", "agent-two", secondAgentPath)
	waitForWorktreeTest(t, "dynamically added third worktree", func() bool {
		roots, err := db.GetActiveRoots(sqlDB, "ws")
		if err != nil || len(roots) != 3 {
			return false
		}
		for _, root := range roots {
			if root.IndexedAt == nil || *root.IndexedAt == 0 {
				return false
			}
		}
		server.mu.RLock()
		watcherCount := len(server.watchers)
		server.mu.RUnlock()
		return watcherCount == 3
	})

	if err := os.WriteFile(
		filepath.Join(secondAgentPath, "live.go"),
		[]byte("package sample\n\nfunc Live() {}\n"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	waitForWorktreeTest(t, "new file from the third worktree watcher", func() bool {
		roots, err := db.GetActiveRoots(sqlDB, "ws")
		if err != nil {
			return false
		}
		for _, root := range roots {
			if !sameRootPath(root.Path, secondAgentPath) {
				continue
			}
			file, err := db.GetFileByRelPath(sqlDB, root.ID, "live.go")
			return err == nil && file != nil
		}
		return false
	})
}
