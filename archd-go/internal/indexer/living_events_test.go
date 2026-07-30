package indexer

import (
	"testing"

	"axiom.local/archd/internal/db"
)

func TestDiffRelationshipChangesFunctionLifecycle(t *testing.T) {
	before := []db.CallEdge{{
		CallerFile: "service", CallerSymbol: "build",
		CalleeFile: "store", CalleeSymbol: "save", CallCount: 1,
	}}
	updated := []db.CallEdge{{
		CallerFile: "service", CallerSymbol: "build",
		CalleeFile: "store", CalleeSymbol: "save", CallCount: 1,
	}}

	touched := diffRelationshipChanges(nil, nil, before, updated, map[string]struct{}{
		touchedSymbolKey("service", "build"): {},
	})
	if len(touched) != 1 || touched[0].Change != "updated" {
		t.Fatalf("expected one update, got %#v", touched)
	}

	removed := diffRelationshipChanges(nil, nil, before, nil, nil)
	if len(removed) != 1 || removed[0].Change != "removed" {
		t.Fatalf("expected one removed call, got %#v", removed)
	}

	added := diffRelationshipChanges(nil, nil, nil, updated, nil)
	if len(added) != 1 || added[0].Change != "added" {
		t.Fatalf("expected one added call, got %#v", added)
	}
}

func TestDiffRelationshipChangesSuppressesCoincidentImportPulse(t *testing.T) {
	dep := db.Dependency{
		ID: "import", Src: "service", Dst: "store",
		DependencyType: "IMPORTS",
	}
	call := db.CallEdge{
		CallerFile: "service", CallerSymbol: "build",
		CalleeFile: "store", CalleeSymbol: "save", CallCount: 1,
	}

	changes := diffRelationshipChanges(nil, []db.Dependency{dep}, nil, []db.CallEdge{call}, nil)
	if len(changes) != 2 {
		t.Fatalf("expected semantic import plus call delta, got %#v", changes)
	}
	animated := 0
	for _, change := range changes {
		if change.Animate {
			animated++
			if change.Relationship != "CALLS" {
				t.Fatalf("expected CALLS to own the visual pulse, got %#v", changes)
			}
		}
	}
	if animated != 1 {
		t.Fatalf("expected exactly one visual pulse, got %#v", changes)
	}
}

func TestDiffRelationshipChangesPreservesSemanticImportDelta(t *testing.T) {
	dep := db.Dependency{
		ID: "import", Src: "service", Dst: "models",
		DependencyType: "IMPORTS",
	}
	added := diffRelationshipChanges(nil, []db.Dependency{dep}, nil, nil, nil)
	if len(added) != 1 || added[0].Dependency == nil || added[0].Change != "added" {
		t.Fatalf("expected semantic import addition, got %#v", added)
	}

	removed := diffRelationshipChanges([]db.Dependency{dep}, nil, nil, nil, nil)
	if len(removed) != 1 || removed[0].DependencyID != "import" || removed[0].Change != "removed" {
		t.Fatalf("expected semantic import removal, got %#v", removed)
	}
}

func TestDiffRelationshipChangesIgnoresUnrelatedFileEdits(t *testing.T) {
	edge := db.CallEdge{
		CallerFile: "service", CallerSymbol: "build",
		CalleeFile: "store", CalleeSymbol: "save", CallCount: 1,
	}
	changes := diffRelationshipChanges(nil, nil, []db.CallEdge{edge}, []db.CallEdge{edge}, nil)
	if len(changes) != 0 {
		t.Fatalf("unchanged call edge must not animate for unrelated file activity: %#v", changes)
	}
}

func TestDiffRelationshipChangesTracksChangedCallee(t *testing.T) {
	edge := db.CallEdge{
		CallerFile: "service", CallerSymbol: "build",
		CalleeFile: "store", CalleeSymbol: "save", CallCount: 1,
	}
	changes := diffRelationshipChanges(nil, nil, []db.CallEdge{edge}, []db.CallEdge{edge}, map[string]struct{}{
		touchedSymbolKey("store", "save"): {},
	})
	if len(changes) != 1 || changes[0].Change != "updated" {
		t.Fatalf("changed callee must animate its incoming relationship: %#v", changes)
	}
}
