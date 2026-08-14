package db

import "testing"

func proposalFixture(t *testing.T) (*ArchitectureProposal, *File, *File) {
	t.Helper()
	first := &File{ID: "file-a", RootID: "root", Path: "a.go", RelPath: "a.go", Language: "go"}
	second := &File{ID: "file-b", RootID: "root", Path: "b.go", RelPath: "b.go", Language: "go"}
	proposal := &ArchitectureProposal{
		WorkspaceID: "ws", ParentScopeType: "workspace", CreatedBy: "agent",
		Round: ArchitectureProposalRound{
			Coverage: "complete", Rationale: "responsibility boundaries", EvidenceSummary: "imports and behavior",
			Systems: []ArchitectureProposalSystem{
				{SystemKey: "parent", Name: "Parent", ParentRefType: "scope", Depth: 0},
				{SystemKey: "child", Name: "Child", ParentRefType: "proposed_system", ParentRefID: "parent", Depth: 1},
			},
			Memberships: []ArchitectureProposalMembership{
				{FileID: &first.ID, RootID: "root", FilePath: first.RelPath, TargetSystemKey: "parent", Disposition: "assign"},
				{FileID: &second.ID, RootID: "root", FilePath: second.RelPath, TargetSystemKey: "child", Disposition: "assign"},
			},
		},
	}
	return proposal, first, second
}

func TestArchitectureProposalApprovalIsIsolatedAndAtomic(t *testing.T) {
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := UpsertWorkspace(database, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertRoot(database, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}); err != nil {
		t.Fatal(err)
	}
	proposal, first, second := proposalFixture(t)
	proposal.RootID = stringPtr("root")
	for i := range proposal.Round.Memberships {
		proposal.Round.Memberships[i].FileID = nil
	}
	for _, file := range []*File{first, second} {
		if err := UpsertFile(database, *file); err != nil {
			t.Fatal(err)
		}
	}
	created, err := CreateArchitectureProposal(database, *proposal)
	if err != nil {
		t.Fatal(err)
	}
	if systems, _ := GetSystems(database, "ws"); len(systems) != 0 {
		t.Fatalf("pending proposal leaked into live systems: %#v", systems)
	}
	for _, file := range []*File{first, second} {
		got, _ := GetFileByID(database, file.ID)
		if got.SystemID != nil {
			t.Fatalf("pending proposal changed membership: %#v", got)
		}
	}
	if _, err := DecideArchitectureProposalSystem(database, created.ID, "ws", "child", 1, ArchitectureProposalDecision{Decision: "approved", DecidedBy: "max"}); err == nil {
		t.Fatal("child approval should wait for its proposed parent")
	}
	parent, err := DecideArchitectureProposalSystem(database, created.ID, "ws", "parent", 1, ArchitectureProposalDecision{Decision: "approved", DecidedBy: "max"})
	if err != nil {
		t.Fatal(err)
	}
	if parent.MaterializedSystemID == nil {
		t.Fatal("approved parent was not materialized")
	}
	gotFirst, _ := GetFileByID(database, first.ID)
	gotSecond, _ := GetFileByID(database, second.ID)
	if gotFirst.SystemID == nil || *gotFirst.SystemID != *parent.MaterializedSystemID {
		t.Fatalf("approved membership not applied: %#v", gotFirst)
	}
	if gotSecond.SystemID != nil {
		t.Fatalf("unapproved membership applied: %#v", gotSecond)
	}
	child, err := DecideArchitectureProposalSystem(database, created.ID, "ws", "child", 1, ArchitectureProposalDecision{Decision: "approved", DecidedBy: "max"})
	if err != nil {
		t.Fatal(err)
	}
	materializedChild, err := GetSystem(database, *child.MaterializedSystemID)
	if err != nil {
		t.Fatal(err)
	}
	if materializedChild.ParentID == nil || *materializedChild.ParentID != *parent.MaterializedSystemID {
		t.Fatalf("child parent not materialized: %#v", materializedChild)
	}
}

func TestArchitectureProposalRejectsWithDurableReasonAndRevision(t *testing.T) {
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := UpsertWorkspace(database, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertRoot(database, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}); err != nil {
		t.Fatal(err)
	}
	proposal, first, second := proposalFixture(t)
	proposal.RootID = stringPtr("root")
	for i := range proposal.Round.Memberships {
		proposal.Round.Memberships[i].FileID = nil
	}
	for _, file := range []*File{first, second} {
		if err := UpsertFile(database, *file); err != nil {
			t.Fatal(err)
		}
	}
	created, err := CreateArchitectureProposal(database, *proposal)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecideArchitectureProposalSystem(database, created.ID, "ws", "parent", 1, ArchitectureProposalDecision{Decision: "rejected"}); err == nil {
		t.Fatal("blank rejection reason accepted")
	}
	rejected, err := DecideArchitectureProposalSystem(database, created.ID, "ws", "parent", 1, ArchitectureProposalDecision{Decision: "rejected", RejectionReason: "boundary is too broad", DecidedBy: "max"})
	if err != nil {
		t.Fatal(err)
	}
	if rejected.RejectionReason != "boundary is too broad" {
		t.Fatalf("reason = %q", rejected.RejectionReason)
	}
	if _, err := DecideArchitectureProposalSystem(database, created.ID, "ws", "parent", 1, ArchitectureProposalDecision{Decision: "approved"}); err == nil {
		t.Fatal("rejected candidate was reversed")
	}
	revision := ArchitectureProposalRound{Coverage: "partial", Rationale: "narrower", Systems: []ArchitectureProposalSystem{{SystemKey: "parent-v2", Name: "Narrow Parent", ParentRefType: "scope", Depth: 0}}}
	updated, err := AddArchitectureProposalRevision(database, created.ID, "ws", 1, revision)
	if err != nil {
		t.Fatal(err)
	}
	if updated.CurrentRevision != 2 || updated.Round.Systems[0].Decision != "pending" {
		t.Fatalf("revision = %#v", updated)
	}
	if _, err := AddArchitectureProposalRevision(database, created.ID, "ws", 1, revision); err == nil {
		t.Fatal("stale revision accepted")
	}
	var reason string
	if err := database.QueryRow(`SELECT rejection_reason FROM architecture_proposal_systems WHERE proposal_id=? AND revision=1 AND system_key='parent'`, created.ID).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if reason != "boundary is too broad" {
		t.Fatalf("old rejection reason lost: %q", reason)
	}
}

func TestArchitectureProposalReviewLayoutPersistsNestingAndMaterializesGeometry(t *testing.T) {
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := UpsertWorkspace(database, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertRoot(database, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}); err != nil {
		t.Fatal(err)
	}
	proposal, first, second := proposalFixture(t)
	proposal.RootID = stringPtr("root")
	for _, file := range []*File{first, second} {
		if err := UpsertFile(database, *file); err != nil {
			t.Fatal(err)
		}
	}
	created, err := CreateArchitectureProposal(database, *proposal)
	if err != nil {
		t.Fatal(err)
	}
	var firstMembershipID string
	for _, membership := range created.Round.Memberships {
		if membership.FileID != nil && *membership.FileID == first.ID {
			firstMembershipID = membership.ID
		}
	}
	if firstMembershipID == "" {
		t.Fatal("first proposal membership was not returned")
	}

	reviewed, err := ApplyArchitectureProposalLayouts(database, created.ID, "ws", 1, []ArchitectureProposalLayout{
		{NodeType: "system", NodeKey: "child", ParentRefType: "scope", PositionX: 125.5, PositionY: 80.25, Width: 640, Height: 420, Scale: 1, InteriorScale: 1},
		{NodeType: "file", NodeKey: firstMembershipID, ParentRefType: "proposed_system", ParentRefID: "child", PositionX: 22.5, PositionY: 64.75, Width: 180, Height: 96, Scale: 1, InteriorScale: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(reviewed.Round.Layouts) != 2 {
		t.Fatalf("review layouts = %#v", reviewed.Round.Layouts)
	}
	for _, system := range reviewed.Round.Systems {
		if system.SystemKey == "child" && (system.ParentRefType != "scope" || system.Depth != 0) {
			t.Fatalf("drag reparent did not update semantic hierarchy: %#v", system)
		}
	}
	for _, membership := range reviewed.Round.Memberships {
		if membership.ID == firstMembershipID && membership.TargetSystemKey != "child" {
			t.Fatalf("file drag did not update proposal membership: %#v", membership)
		}
	}
	if _, err := ApplyArchitectureProposalLayouts(database, created.ID, "ws", 2, reviewed.Round.Layouts); err == nil {
		t.Fatal("stale proposal revision accepted for review layout")
	}

	child, err := DecideArchitectureProposalSystem(database, created.ID, "ws", "child", 1, ArchitectureProposalDecision{Decision: "approved", DecidedBy: "max"})
	if err != nil {
		t.Fatal(err)
	}
	if child.MaterializedSystemID == nil {
		t.Fatal("reviewed child was not materialized")
	}
	layouts, err := GetFloorLayouts(database, "ws")
	if err != nil {
		t.Fatal(err)
	}
	byNode := make(map[string]FloorLayout)
	for _, layout := range layouts {
		byNode[layout.NodeID] = layout
	}
	if got := byNode[*child.MaterializedSystemID]; got.PositionX != 125.5 || got.Width != 640 || got.ParentNodeID != nil {
		t.Fatalf("reviewed system geometry was not materialized: %#v", got)
	}
	if got := byNode[first.ID]; got.ParentNodeID == nil || *got.ParentNodeID != *child.MaterializedSystemID || got.PositionX != 22.5 {
		t.Fatalf("reviewed file geometry was not materialized: %#v", got)
	}
}

func TestFinalizeArchitectureProposalCommitsReviewedTreeAndLayoutAtomically(t *testing.T) {
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := UpsertWorkspace(database, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertRoot(database, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}); err != nil {
		t.Fatal(err)
	}
	proposal, first, second := proposalFixture(t)
	proposal.RootID = stringPtr("root")
	for i := range proposal.Round.Memberships {
		proposal.Round.Memberships[i].FileID = nil
	}
	for _, file := range []*File{first, second} {
		if err := UpsertFile(database, *file); err != nil {
			t.Fatal(err)
		}
	}
	created, err := CreateArchitectureProposal(database, *proposal)
	if err != nil {
		t.Fatal(err)
	}
	membershipByFile := make(map[string]string)
	for _, membership := range created.Round.Memberships {
		if membership.FileID != nil {
			membershipByFile[*membership.FileID] = membership.ID
		}
	}
	if membershipByFile[first.ID] == "" || membershipByFile[second.ID] == "" {
		t.Fatalf("proposal memberships were not resolved: %#v", created.Round.Memberships)
	}
	if _, err := ApplyArchitectureProposalLayouts(database, created.ID, "ws", 1, []ArchitectureProposalLayout{
		{NodeType: "system", NodeKey: "parent", ParentRefType: "scope", PositionX: 100, PositionY: 120, Width: 900, Height: 640, Scale: 1, InteriorScale: 0.8},
		{NodeType: "system", NodeKey: "child", ParentRefType: "proposed_system", ParentRefID: "parent", PositionX: 42, PositionY: 88, Width: 420, Height: 280, Scale: 1, InteriorScale: 1},
		{NodeType: "file", NodeKey: membershipByFile[first.ID], ParentRefType: "proposed_system", ParentRefID: "parent", PositionX: 520, PositionY: 96, Width: 180, Height: 96, Scale: 1, InteriorScale: 1},
		{NodeType: "file", NodeKey: membershipByFile[second.ID], ParentRefType: "proposed_system", ParentRefID: "child", PositionX: 32, PositionY: 72, Width: 180, Height: 96, Scale: 1, InteriorScale: 1},
	}); err != nil {
		t.Fatal(err)
	}

	finalized, err := FinalizeArchitectureProposal(database, created.ID, "ws", 1, "max")
	if err != nil {
		t.Fatal(err)
	}
	for _, system := range finalized.Round.Systems {
		if system.Decision != ProposalDecisionApproved || system.MaterializedSystemID == nil {
			t.Fatalf("system was not finalized: %#v", system)
		}
	}
	canonical, err := GetSystems(database, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(canonical) != 2 {
		t.Fatalf("canonical systems = %#v", canonical)
	}
	byName := make(map[string]System)
	for _, system := range canonical {
		byName[system.Name] = system
	}
	parent := byName["Parent"]
	child := byName["Child"]
	if child.ParentID == nil || *child.ParentID != parent.ID {
		t.Fatalf("reviewed nesting was not committed: parent=%#v child=%#v", parent, child)
	}
	gotFirst, _ := GetFileByID(database, first.ID)
	gotSecond, _ := GetFileByID(database, second.ID)
	if gotFirst.SystemID == nil || *gotFirst.SystemID != parent.ID {
		t.Fatalf("parent membership was not committed: %#v", gotFirst)
	}
	if gotSecond.SystemID == nil || *gotSecond.SystemID != child.ID {
		t.Fatalf("child membership was not committed: %#v", gotSecond)
	}
	layouts, err := GetFloorLayouts(database, "ws")
	if err != nil {
		t.Fatal(err)
	}
	byNode := make(map[string]FloorLayout)
	for _, layout := range layouts {
		byNode[layout.NodeID] = layout
	}
	if got := byNode[parent.ID]; got.PositionX != 100 || got.Width != 900 || got.InteriorScale != 0.8 {
		t.Fatalf("parent review layout was not committed: %#v", got)
	}
	if got := byNode[child.ID]; got.ParentNodeID == nil || *got.ParentNodeID != parent.ID || got.PositionX != 42 {
		t.Fatalf("child review layout was not committed: %#v", got)
	}
	if got := byNode[second.ID]; got.ParentNodeID == nil || *got.ParentNodeID != child.ID || got.PositionX != 32 {
		t.Fatalf("file review layout was not committed: %#v", got)
	}
	var layoutRevision int
	if err := database.QueryRow(`SELECT revision FROM floor_layout_revisions WHERE workspace_id='ws'`).Scan(&layoutRevision); err != nil {
		t.Fatal(err)
	}
	if layoutRevision != 1 {
		t.Fatalf("one review commit must publish one layout revision, got %d", layoutRevision)
	}
}

func TestFinalizeArchitectureProposalPrunesSupersededClassifierShells(t *testing.T) {
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := UpsertWorkspace(database, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertRoot(database, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}); err != nil {
		t.Fatal(err)
	}

	oldParent := System{ID: "cluster_parent", WorkspaceID: "ws", Name: "Old Parent", Source: "cluster"}
	oldChild := System{ID: "cluster_child", WorkspaceID: "ws", Name: "Old Child", Source: "cluster", ParentID: &oldParent.ID, Depth: 1}
	retained := System{ID: "cluster_retained", WorkspaceID: "ws", Name: "Still Classified", Source: "cluster"}
	authoredEmpty := System{ID: "user_empty", WorkspaceID: "ws", Name: "Authored Empty", Source: "user"}
	for _, system := range []System{oldParent, oldChild, retained, authoredEmpty} {
		if err := UpsertSystem(database, system); err != nil {
			t.Fatal(err)
		}
	}

	proposal, first, second := proposalFixture(t)
	proposal.RootID = stringPtr("root")
	first.SystemID = &oldChild.ID
	second.SystemID = &oldChild.ID
	third := File{ID: "file-c", RootID: "root", Path: "c.go", RelPath: "c.go", Language: "go", SystemID: &retained.ID}
	for _, file := range []*File{first, second, &third} {
		if err := UpsertFile(database, *file); err != nil {
			t.Fatal(err)
		}
	}
	created, err := CreateArchitectureProposal(database, *proposal)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"parent", "child"} {
		if _, err := DecideArchitectureProposalSystem(database, created.ID, "ws", key, 1, ArchitectureProposalDecision{
			Decision: ProposalDecisionApproved, DecidedBy: "max",
		}); err != nil {
			t.Fatal(err)
		}
	}
	if system, err := GetSystem(database, oldChild.ID); err != nil || system == nil {
		t.Fatalf("classifier shell disappeared before the review commit: system=%#v err=%v", system, err)
	}

	if _, err := FinalizeArchitectureProposal(database, created.ID, "ws", 1, "max"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{oldChild.ID, oldParent.ID} {
		if system, err := GetSystem(database, id); err != nil || system != nil {
			t.Fatalf("superseded classifier shell %s survived: system=%#v err=%v", id, system, err)
		}
	}
	for _, id := range []string{retained.ID, authoredEmpty.ID} {
		if system, err := GetSystem(database, id); err != nil || system == nil {
			t.Fatalf("live system %s was pruned: system=%#v err=%v", id, system, err)
		}
	}
	var layoutRevision int
	if err := database.QueryRow(`SELECT revision FROM floor_layout_revisions WHERE workspace_id='ws'`).Scan(&layoutRevision); err != nil {
		t.Fatal(err)
	}
	if layoutRevision != 1 {
		t.Fatalf("classifier cleanup must publish one Floor revision, got %d", layoutRevision)
	}
}

func TestFinalizeArchitectureProposalRollsBackBlockedRemainder(t *testing.T) {
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := UpsertWorkspace(database, Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertRoot(database, Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}); err != nil {
		t.Fatal(err)
	}
	proposal, first, second := proposalFixture(t)
	proposal.RootID = stringPtr("root")
	for i := range proposal.Round.Memberships {
		proposal.Round.Memberships[i].FileID = nil
	}
	for _, file := range []*File{first, second} {
		if err := UpsertFile(database, *file); err != nil {
			t.Fatal(err)
		}
	}
	created, err := CreateArchitectureProposal(database, *proposal)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecideArchitectureProposalSystem(database, created.ID, "ws", "parent", 1, ArchitectureProposalDecision{
		Decision: ProposalDecisionRejected, RejectionReason: "wrong container", DecidedBy: "max",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := FinalizeArchitectureProposal(database, created.ID, "ws", 1, "max"); err == nil {
		t.Fatal("finalization accepted a pending child beneath a rejected parent")
	}
	if systems, _ := GetSystems(database, "ws"); len(systems) != 0 {
		t.Fatalf("failed finalization leaked canonical systems: %#v", systems)
	}
	for _, file := range []*File{first, second} {
		got, _ := GetFileByID(database, file.ID)
		if got.SystemID != nil {
			t.Fatalf("failed finalization leaked membership for %s: %#v", file.ID, got)
		}
	}
}
