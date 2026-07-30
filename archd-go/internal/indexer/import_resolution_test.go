package indexer

import (
	"testing"

	"axiom.local/archd/internal/db"
)

func TestPythonImportResolutionUsesModulesNotDirectoryMembership(t *testing.T) {
	files := []db.File{
		{ID: "models-init", RelPath: "models/__init__.py", Language: "python"},
		{ID: "task", RelPath: "models/task.py", Language: "python"},
		{ID: "storage-init", RelPath: "storage/__init__.py", Language: "python"},
		{ID: "store", RelPath: "storage/task_store.py", Language: "python"},
		{ID: "nested", RelPath: "storage/internal/adapter.py", Language: "python"},
	}
	index := buildImportPathIndex(files)

	tests := []struct {
		name     string
		source   db.File
		imported string
		wantID   string
	}{
		{
			name:     "absolute dotted module",
			source:   db.File{RelPath: "services/task_service.py", Language: "python"},
			imported: "models.task",
			wantID:   "task",
		},
		{
			name:     "package resolves to init",
			source:   db.File{RelPath: "main.py", Language: "python"},
			imported: "models",
			wantID:   "models-init",
		},
		{
			name:     "single-dot relative module",
			source:   files[2],
			imported: ".task_store",
			wantID:   "store",
		},
		{
			name:     "double-dot relative module",
			source:   files[4],
			imported: "..task_store",
			wantID:   "store",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := resolveImportFileID(test.source, test.imported, index)
			if !ok || got != test.wantID {
				t.Fatalf("resolve %q from %q = %q, %v; want %q, true",
					test.imported, test.source.RelPath, got, ok, test.wantID)
			}
		})
	}
}
