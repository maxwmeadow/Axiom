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
