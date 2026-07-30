package api

import (
	"testing"

	"axiom.local/archd/internal/db"
)

func TestDispatchedIntentsComeFromImmutableCanvasSnapshot(t *testing.T) {
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	message := db.CanvasMessage{
		ID: "dispatch", WorkspaceID: "ws",
		SheetContext: `{
			"schemaVersion":1,
			"sheet":{"id":"sheet"},
			"nodes":[
				{"id":"planned:p1","type":"file","name":"Token","planned":true,"declaredPath":"src/token.go","sheet":{"x":0,"y":0}},
				{"id":"file:existing","type":"file","name":"Existing","planned":false,"sheet":{"x":0,"y":0}}
			],
			"edges":[
				{"kind":"CALLS","source":"planned://file/Token","target":"file://src/auth.go","planned":true},
				{"kind":"CALLS","source":"file://old.go","target":"file://src/auth.go"}
			],
			"notes":[]
		}`,
	}
	if err := db.EnqueueCanvasMessage(sqlDB, &message); err != nil {
		t.Fatal(err)
	}

	intents := dispatchedIntents(sqlDB, "ws")
	if len(intents) != 2 {
		t.Fatalf("only planned nodes and planned edges are intent: %#v", intents)
	}
	if intents[0].DeclaredPath != "src/token.go" || intents[1].Kind != "edge" {
		t.Fatalf("dispatch snapshot was not preserved: %#v", intents)
	}
}
