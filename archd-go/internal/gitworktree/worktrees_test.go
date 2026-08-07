package gitworktree

import (
	"path/filepath"
	"testing"
)

func TestParsePorcelainPreservesOrderAndBranchIdentity(t *testing.T) {
	input := []byte(
		"worktree C:/code/Axiom\x00" +
			"HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x00" +
			"branch refs/heads/main\x00\x00" +
			"worktree C:/code/Axiom feature\x00" +
			"HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x00" +
			"branch refs/heads/feature/agents\x00" +
			"locked reason with spaces\x00\x00" +
			"worktree C:/code/detached\x00" +
			"HEAD cccccccccccccccccccccccccccccccccccccccc\x00" +
			"detached\x00\x00",
	)

	worktrees, err := parsePorcelain(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(worktrees) != 3 {
		t.Fatalf("worktrees = %d, want 3", len(worktrees))
	}
	if !worktrees[0].Primary || worktrees[0].Branch != "main" {
		t.Fatalf("primary worktree = %#v", worktrees[0])
	}
	if worktrees[1].Primary || worktrees[1].Branch != "feature/agents" {
		t.Fatalf("linked worktree = %#v", worktrees[1])
	}
	if worktrees[1].Path != filepath.Clean(filepath.FromSlash("C:/code/Axiom feature")) {
		t.Fatalf("path with spaces = %q", worktrees[1].Path)
	}
	if worktrees[2].Branch != DetachedBranch {
		t.Fatalf("detached branch = %q", worktrees[2].Branch)
	}
}

func TestParsePorcelainRejectsIncompleteAndEmptyRecords(t *testing.T) {
	for name, input := range map[string][]byte{
		"empty":        nil,
		"missing head": []byte("worktree C:/code/Axiom\x00\x00"),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parsePorcelain(input); err == nil {
				t.Fatal("expected malformed porcelain to fail")
			}
		})
	}
}

func TestParsePorcelainSkipsBareRepositoryAdministrationRoot(t *testing.T) {
	input := []byte(
		"worktree C:/code/repo.git\x00" +
			"bare\x00\x00" +
			"worktree C:/code/checkout\x00" +
			"HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x00" +
			"branch refs/heads/main\x00\x00",
	)
	worktrees, err := parsePorcelain(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(worktrees) != 1 || worktrees[0].Path != filepath.Clean(filepath.FromSlash("C:/code/checkout")) || !worktrees[0].Primary {
		t.Fatalf("source worktrees = %#v", worktrees)
	}
}
