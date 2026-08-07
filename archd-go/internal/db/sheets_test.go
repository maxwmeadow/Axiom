package db

import "testing"

// A sheet's name is how the rail, the dispatch history, and every agent refer
// to it. Two sheets sharing one makes all three ambiguous, so the check has to
// be as forgiving as a human reading the two names side by side.
func TestSheetNameTakenIgnoresCaseSpaceAndTheSheetBeingRenamed(t *testing.T) {
	sqlDB, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	if err := UpsertWorkspace(sqlDB, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertWorkspace(sqlDB, Workspace{ID: "other", Name: "other"}); err != nil {
		t.Fatal(err)
	}
	sheet := Sheet{ID: "sheet", WorkspaceID: "ws", Name: "First Increment"}
	if err := CreateSheet(sqlDB, &sheet); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name        string
		workspaceID string
		candidate   string
		excludeID   string
		want        bool
	}{
		{"exact match is taken", "ws", "First Increment", "", true},
		{"case differences are the same name", "ws", "first increment", "", true},
		{"surrounding space is the same name", "ws", "  First Increment ", "", true},
		{"a different name is free", "ws", "Second Increment", "", false},
		{"another workspace is unaffected", "other", "First Increment", "", false},
		{"renaming a sheet does not collide with itself", "ws", "First Increment", "sheet", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := SheetNameTaken(sqlDB, tc.workspaceID, tc.candidate, tc.excludeID)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("SheetNameTaken(%q, exclude %q) = %v, want %v",
					tc.candidate, tc.excludeID, got, tc.want)
			}
		})
	}
}
