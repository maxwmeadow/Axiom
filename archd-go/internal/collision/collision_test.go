package collision

import (
	"testing"

	"axiom.local/archd/internal/delta"
)

func TestBuildSurfacesOnlyPairwiseSemanticOverlap(t *testing.T) {
	inputs := []BranchInput{
		{
			RootID: "a", Branch: "feature/a", IsPrimary: true,
			PathSystems: map[string]Boundary{
				"payments/a.go": {SystemID: "payments", SystemName: "Payments"},
				"shared/a.go":   {SystemID: "shared", SystemName: "Shared"},
			},
			Claims: []delta.Claim{{ID: "claim-a", Title: "Payments changed", FocusSystemIDs: []string{"payments"}}},
		},
		{
			RootID: "b", Branch: "feature/b",
			PathSystems: map[string]Boundary{
				"payments/b.go": {SystemID: "payments", SystemName: "Payments"},
				"other/b.go":    {SystemID: "other", SystemName: "Other"},
			},
			Claims: []delta.Claim{{ID: "claim-b", Title: "Payment flow", FocusSystemIDs: []string{"payments"}}},
		},
	}
	snapshot := Build("ws", 100, inputs, []PairInput{{
		LeftRootID: "a", LeftPaths: []string{"payments/a.go", "shared/a.go"},
		RightRootID: "b", RightPaths: []string{"payments/b.go", "other/b.go"},
	}})
	if len(snapshot.Collisions) != 1 || snapshot.Collisions[0].SystemID != "payments" {
		t.Fatalf("collisions = %#v", snapshot.Collisions)
	}
	if len(snapshot.Collisions[0].Branches) != 2 {
		t.Fatalf("collision branches = %#v", snapshot.Collisions[0].Branches)
	}
	for _, branch := range snapshot.Collisions[0].Branches {
		if len(branch.Claims) != 1 || len(branch.Files) != 1 {
			t.Fatalf("branch evidence = %#v", branch)
		}
	}
}

func TestBuildDoesNotTreatInheritedChangesAsIndependentTouch(t *testing.T) {
	inputs := []BranchInput{
		{RootID: "parent", Branch: "feature/parent", PathSystems: map[string]Boundary{
			"payments/shared.go": {SystemID: "payments", SystemName: "Payments"},
		}},
		{RootID: "child", Branch: "feature/child", PathSystems: map[string]Boundary{
			"payments/shared.go": {SystemID: "payments", SystemName: "Payments"},
			"payments/child.go":  {SystemID: "payments", SystemName: "Payments"},
		}},
	}
	snapshot := Build("ws", 100, inputs, []PairInput{{
		LeftRootID: "parent", LeftPaths: nil,
		RightRootID: "child", RightPaths: []string{"payments/child.go"},
	}})
	if len(snapshot.Collisions) != 0 {
		t.Fatalf("inherited work surfaced as collision: %#v", snapshot.Collisions)
	}
}

func TestBuildKeepsUnclassifiedAndGitErrorsVisible(t *testing.T) {
	inputs := []BranchInput{
		{RootID: "a", Branch: "a", PathSystems: map[string]Boundary{}},
		{RootID: "b", Branch: "b", PathSystems: map[string]Boundary{}},
	}
	snapshot := Build("ws", 100, inputs, []PairInput{
		{LeftRootID: "a", LeftPaths: []string{"new/a.go"}, RightRootID: "b"},
		{LeftRootID: "a", RightRootID: "b", Error: "merge base unavailable"},
	})
	if len(snapshot.Branches[0].UnclassifiedFiles) != 1 || len(snapshot.Branches[0].Errors) != 1 {
		t.Fatalf("branch diagnostics = %#v", snapshot.Branches[0])
	}
	if len(snapshot.Collisions) != 0 {
		t.Fatalf("unclassified files cannot establish a semantic collision: %#v", snapshot.Collisions)
	}
}
