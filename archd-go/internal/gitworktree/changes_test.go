package gitworktree

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", dir}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
	return string(output)
}

func writeGitFile(t *testing.T, dir, relPath, content string) {
	t.Helper()
	path := filepath.Join(dir, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func gitChangeFixture(t *testing.T) (primary, branch, base string) {
	t.Helper()
	primary = filepath.Join(t.TempDir(), "primary")
	branch = filepath.Join(t.TempDir(), "branch")
	if err := os.MkdirAll(primary, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, primary, "init", "-b", "main")
	runGit(t, primary, "config", "user.email", "axiom@example.test")
	runGit(t, primary, "config", "user.name", "Axiom Test")
	writeGitFile(t, primary, "shared/base.go", "package shared\n")
	runGit(t, primary, "add", ".")
	runGit(t, primary, "commit", "-m", "base")
	base = runGit(t, primary, "rev-parse", "HEAD")
	runGit(t, primary, "worktree", "add", "-b", "feature/agents", branch, "HEAD")
	return primary, branch, base
}

func TestChangedPathsCoverBothCommittedSidesAndUncommittedFiles(t *testing.T) {
	primary, branch, _ := gitChangeFixture(t)
	writeGitFile(t, primary, "payments/main.go", "package payments\n")
	runGit(t, primary, "add", ".")
	runGit(t, primary, "commit", "-m", "primary payment")
	writeGitFile(t, branch, "payments/agent.go", "package payments\n")
	runGit(t, branch, "add", ".")
	runGit(t, branch, "commit", "-m", "branch payment")

	primaryHead := strings.TrimSpace(runGit(t, primary, "rev-parse", "HEAD"))
	branchHead := strings.TrimSpace(runGit(t, branch, "rev-parse", "HEAD"))
	base, err := MergeBase(primary, primaryHead, branchHead)
	if err != nil {
		t.Fatal(err)
	}
	primaryPaths, err := CommittedChangedPaths(primary, base, primaryHead)
	if err != nil {
		t.Fatal(err)
	}
	branchPaths, err := CommittedChangedPaths(branch, base, branchHead)
	if err != nil {
		t.Fatal(err)
	}
	if len(primaryPaths) != 1 || primaryPaths[0] != "payments/main.go" {
		t.Fatalf("primary paths = %#v", primaryPaths)
	}
	if len(branchPaths) != 1 || branchPaths[0] != "payments/agent.go" {
		t.Fatalf("branch paths = %#v", branchPaths)
	}

	writeGitFile(t, branch, "payments/untracked.go", "package payments\n")
	writeGitFile(t, branch, "shared/base.go", "package shared\n// edited\n")
	working, err := WorkingChangedPaths(branch)
	if err != nil {
		t.Fatal(err)
	}
	if len(working) != 2 || working[0] != "payments/untracked.go" || working[1] != "shared/base.go" {
		t.Fatalf("working paths = %#v", working)
	}
}
