package indexer

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
)

func TestReindexFileBroadcastsOnlyTruthfulCrossFileCallChanges(t *testing.T) {
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	projectDir := t.TempDir()
	callerPath := filepath.Join(projectDir, "caller.py")
	calleePath := filepath.Join(projectDir, "worker.py")
	writeLivingFixture(t, callerPath, `from worker import transform

def run(value):
    return transform(value)
`)
	writeLivingFixture(t, calleePath, `def transform(value):
    return value + 1
`)

	root := db.Root{ID: "root", WorkspaceID: "ws", Path: projectDir}
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "living"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	eventHub := hub.New()
	if err := IndexRoot(sqlDB, eventHub, root, nil); err != nil {
		t.Fatal(err)
	}

	caller := requiredLivingFile(t, sqlDB, root.ID, "caller.py")
	callee := requiredLivingFile(t, sqlDB, root.ID, "worker.py")
	assertLivingCallGraph(t, sqlDB, root.ID, caller.ID, callee.ID, true)

	var relationships []RelationshipChange
	eventHub.SetTap(func(msgType string, raw json.RawMessage) {
		if msgType != "graph:patch" {
			return
		}
		var patch struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal(raw, &patch); err != nil || patch.Type != "relationship:changed" {
			return
		}
		var relationship RelationshipChange
		if err := json.Unmarshal(patch.Payload, &relationship); err == nil {
			relationships = append(relationships, relationship)
		}
	})

	// Editing the callee body keeps the topology but must animate the incoming
	// relationship because that exact participating function changed.
	writeLivingFixture(t, calleePath, `def transform(value):
    return value + 2
`)
	if err := ReindexFile(sqlDB, eventHub, root, calleePath); err != nil {
		t.Fatal(err)
	}
	assertSingleLivingRelationship(t, relationships, caller.ID, callee.ID, callee.ID, "updated")
	relationships = nil

	// A module comment is a real file edit, but it does not change transform.
	// The file card should animate while the call edge stays quiet.
	writeLivingFixture(t, calleePath, `# Worker implementation.
def transform(value):
    return value + 2
`)
	if err := ReindexFile(sqlDB, eventHub, root, calleePath); err != nil {
		t.Fatal(err)
	}
	if len(relationships) != 0 {
		t.Fatalf("unrelated edit broadcast %d relationship changes: %#v", len(relationships), relationships)
	}

	// Removing and restoring the callee symbol must re-resolve callers across
	// the project, even though caller.py itself never received a watcher event.
	writeLivingFixture(t, calleePath, `VALUE = 2
`)
	if err := ReindexFile(sqlDB, eventHub, root, calleePath); err != nil {
		t.Fatal(err)
	}
	assertSingleLivingRelationship(t, relationships, caller.ID, callee.ID, callee.ID, "removed")
	assertLivingCallGraph(t, sqlDB, root.ID, caller.ID, callee.ID, false)
	relationships = nil

	writeLivingFixture(t, calleePath, `def transform(value):
    return value + 3
`)
	if err := ReindexFile(sqlDB, eventHub, root, calleePath); err != nil {
		t.Fatal(err)
	}
	assertSingleLivingRelationship(t, relationships, caller.ID, callee.ID, callee.ID, "added")
	assertLivingCallGraph(t, sqlDB, root.ID, caller.ID, callee.ID, true)
}

func TestTaskStorePopTypoProducesTwoFilePulsesAndNoFlows(t *testing.T) {
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	projectDir := t.TempDir()
	taskStorePath := filepath.Join(projectDir, "storage", "task_store.py")
	if err := os.MkdirAll(filepath.Dir(taskStorePath), 0o755); err != nil {
		t.Fatal(err)
	}
	const prefix = `class TaskStore:
    def __init__(self) -> None:
        self._tasks = {}

    def delete(self, task_id: str) -> bool:
        return self._tasks.`
	const suffix = `(task_id, None) is not None
`
	writeLivingFixture(t, taskStorePath, prefix+"pop"+suffix)

	root := db.Root{ID: "root", WorkspaceID: "ws", Path: projectDir}
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "task-store"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	eventHub := hub.New()
	if err := IndexRoot(sqlDB, eventHub, root, nil); err != nil {
		t.Fatal(err)
	}

	var filePatches []FileUpdatePatch
	var relationships []RelationshipChange
	eventHub.SetTap(func(msgType string, raw json.RawMessage) {
		if msgType != "graph:patch" {
			return
		}
		var patch struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if json.Unmarshal(raw, &patch) != nil {
			return
		}
		switch patch.Type {
		case "file:updated":
			var payload FileUpdatePatch
			if json.Unmarshal(patch.Payload, &payload) == nil {
				filePatches = append(filePatches, payload)
			}
		case "relationship:changed":
			var payload RelationshipChange
			if json.Unmarshal(patch.Payload, &payload) == nil {
				relationships = append(relationships, payload)
			}
		}
	})

	traceIDs := make([]string, 0, 2)
	for _, method := range []string{"pp", "pop"} {
		filePatches = nil
		relationships = nil
		writeLivingFixture(t, taskStorePath, prefix+method+suffix)
		if err := ReindexFile(sqlDB, eventHub, root, taskStorePath); err != nil {
			t.Fatal(err)
		}
		if len(filePatches) != 1 {
			t.Fatalf("%s save emitted %d file patches, want 1", method, len(filePatches))
		}
		if !filePatches[0].Animate || filePatches[0].Change != "updated" {
			t.Fatalf("%s file patch = %#v, want animated update", method, filePatches[0])
		}
		if filePatches[0].TraceID == "" {
			t.Fatalf("%s save has no living trace id", method)
		}
		if len(relationships) != 0 {
			t.Fatalf("%s save emitted relationships without a project call: %#v", method, relationships)
		}
		traceIDs = append(traceIDs, filePatches[0].TraceID)
	}
	if traceIDs[0] == traceIDs[1] {
		t.Fatalf("distinct saves reused trace id %q", traceIDs[0])
	}
}

func writeLivingFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func requiredLivingFile(t *testing.T, sqlDB *sql.DB, rootID, relPath string) db.File {
	t.Helper()
	file, err := db.GetFileByRelPath(sqlDB, rootID, relPath)
	if err != nil {
		t.Fatal(err)
	}
	if file == nil {
		t.Fatalf("%s was not indexed", relPath)
	}
	return *file
}

func assertSingleLivingRelationship(
	t *testing.T,
	relationships []RelationshipChange,
	src, dst, originID, change string,
) {
	t.Helper()
	if len(relationships) != 1 {
		t.Fatalf("got %d relationship changes, want 1: %#v", len(relationships), relationships)
	}
	got := relationships[0]
	if got.Src != src || got.Dst != dst || got.OriginID != originID ||
		got.Relationship != "CALLS" || got.Change != change || !got.Animate {
		t.Fatalf("relationship = %#v, want origin %s with %s -> %s CALLS %s", got, originID, src, dst, change)
	}
}

func assertLivingCallGraph(
	t *testing.T,
	sqlDB *sql.DB,
	rootID, src, dst string,
	want bool,
) {
	t.Helper()
	edges, err := db.GetCallEdgesByRoot(sqlDB, rootID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, edge := range edges {
		if edge.CallerFile == src && edge.CalleeFile == dst && edge.CalleeSymbol == "transform" {
			found = true
		}
	}
	if found != want {
		t.Fatalf("call graph has %s -> %s = %v, want %v; edges=%#v", src, dst, found, want, edges)
	}
}
