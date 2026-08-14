package indexer

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"axiom.local/archd/internal/db"
)

func TestFileAdmissionSeparatesSourceDocumentsAndAssets(t *testing.T) {
	for _, name := range []string{"main.go", "README.md", "notes.txt", "docs/architecture.rst"} {
		if !IsSupportedSourceFile(name) {
			t.Fatalf("expected %s to be indexable", name)
		}
	}
	for _, name := range []string{"README.md", "notes.txt", "docs/architecture.rst"} {
		if !IsDocumentationFile(name) {
			t.Fatalf("expected %s to be documentation", name)
		}
	}
	for _, name := range []string{"assets/logo.png", "demo.mp4", "design.pdf"} {
		if IsSupportedSourceFile(name) {
			t.Fatalf("binary asset %s must not enter the index", name)
		}
	}
	if IsDocumentationFile("main.go") {
		t.Fatal("source code must not be classified as documentation")
	}
}

func TestCollectSourcePathsIncludesMarkdown(t *testing.T) {
	rootPath := t.TempDir()
	for _, name := range []string{"main.go", "README.md", "notes.txt", "docs/architecture.mdx", "logo.png", "demo.mp4"} {
		absolute := filepath.Join(rootPath, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(absolute, []byte("content\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	paths, err := collectSourcePaths(db.Root{Path: rootPath}, nil)
	if err != nil {
		t.Fatal(err)
	}
	relative := make([]string, 0, len(paths))
	for _, path := range paths {
		rel, err := filepath.Rel(rootPath, path)
		if err != nil {
			t.Fatal(err)
		}
		relative = append(relative, filepath.ToSlash(rel))
	}
	slices.Sort(relative)
	want := []string{"README.md", "docs/architecture.mdx", "main.go", "notes.txt"}
	if !slices.Equal(relative, want) {
		t.Fatalf("indexed paths = %v, want %v", relative, want)
	}
}

func TestDocumentationCannotBecomeArchitectureMembership(t *testing.T) {
	sqlDB, root, eventHub := journalFixture(t)
	markdownPath := filepath.Join(root.Path, "docs", "ASYMM_MASTER_PLAN.md")
	if err := os.MkdirAll(filepath.Dir(markdownPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(markdownPath, []byte("# Architecture\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := IndexRoot(sqlDB, eventHub, root, nil); err != nil {
		t.Fatal(err)
	}

	_, err := db.CreateArchitectureProposal(sqlDB, db.ArchitectureProposal{
		WorkspaceID:     root.WorkspaceID,
		RootID:          &root.ID,
		ParentScopeType: "workspace",
		Round: db.ArchitectureProposalRound{
			Coverage: "complete",
			Systems: []db.ArchitectureProposalSystem{{
				SystemKey: "docs", Name: "Architecture Documents", ParentRefType: "scope",
			}},
			Memberships: []db.ArchitectureProposalMembership{{
				FilePath: "docs/ASYMM_MASTER_PLAN.md", TargetSystemKey: "docs", Disposition: "assign",
			}},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "belongs in Documents") {
		t.Fatalf("documentation membership error = %v", err)
	}
}

func TestClusterScopeExcludesDocumentation(t *testing.T) {
	files := []db.File{
		{ID: "source", RelPath: "main.go", Language: "go"},
		{ID: "docs", RelPath: "README.md", Language: "markdown"},
	}
	managed, _ := clusterScope(files, nil)
	if len(managed) != 1 || managed[0].ID != "source" {
		t.Fatalf("classifier-managed files = %#v, want source only", managed)
	}
}
