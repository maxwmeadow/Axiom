package watcher

import (
	"path/filepath"
	"testing"
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
