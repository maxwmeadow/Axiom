package watcher

import (
	"path/filepath"
	"testing"

	"axiom.local/archd/internal/db"
)

func TestIgnoredSourceBoundaryCoversDescendantsOnly(t *testing.T) {
	root := t.TempDir()
	ignored := filepath.Join(root, "generated")
	patterns := []string{filepath.ToSlash(ignored) + "/**"}

	if !isIgnoredPath(filepath.Join(ignored, "nested", "generated.py"), patterns) {
		t.Fatal("descendant of excluded boundary was not ignored")
	}
	if !isIgnoredPath(ignored, patterns) {
		t.Fatal("excluded boundary directory itself was not ignored")
	}
	if isIgnoredPath(filepath.Join(root, "generated-sibling", "source.py"), patterns) {
		t.Fatal("prefix-similar sibling was incorrectly ignored")
	}
	if isIgnoredPath(filepath.Join(root, "src", "source.py"), patterns) {
		t.Fatal("included source directory was incorrectly ignored")
	}
}

func TestUpdateRootRefreshesResolvedGitIdentity(t *testing.T) {
	rootPath := t.TempDir()
	w := &Watcher{roots: []db.Root{{ID: "root", Path: rootPath, Branch: "old", HeadCommit: "aaa"}}}
	w.UpdateRoot(db.Root{ID: "root", Path: rootPath, Branch: "new", HeadCommit: "bbb"})

	resolved := w.rootFor(filepath.Join(rootPath, "file.go"))
	if resolved == nil || resolved.Branch != "new" || resolved.HeadCommit != "bbb" {
		t.Fatalf("resolved root = %#v", resolved)
	}
}
