package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
	axiomruntime "axiom.local/archd/internal/runtime"
)

func TestSetupProposalFinalizeEstablishesMorningDeltaBaseline(t *testing.T) {
	eventHub := hub.New()
	server := NewServer(t.TempDir(), eventHub, axiomruntime.NewManager(eventHub))
	sqlDB, err := server.openDB("ws")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.closeDB("ws") })
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "review baseline"}); err != nil {
		t.Fatal(err)
	}
	root := db.Root{ID: "root", WorkspaceID: "ws", Path: t.TempDir(), IsPrimary: true}
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	file := db.File{ID: "file", RootID: root.ID, Path: "core.go", RelPath: "core.go", Language: "go"}
	if err := db.UpsertFile(sqlDB, file); err != nil {
		t.Fatal(err)
	}
	oldWatermark := time.Now().Add(-time.Minute).UnixMilli()
	if err := db.SetDeltaReviewedAtForRoot(sqlDB, "ws", root.ID, oldWatermark); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordStructuralEvent(sqlDB, db.StructuralEvent{
		WorkspaceID: "ws", RootID: root.ID, TS: oldWatermark + 1,
		Kind: db.EventFileUpdated, SubjectID: file.ID, SubjectLabel: file.RelPath,
	}); err != nil {
		t.Fatal(err)
	}
	proposal, err := db.CreateArchitectureProposal(sqlDB, db.ArchitectureProposal{
		ID: "proposal", WorkspaceID: "ws", RootID: &root.ID,
		ParentScopeType: "workspace",
		Round: db.ArchitectureProposalRound{
			Coverage: "complete",
			Systems: []db.ArchitectureProposalSystem{{
				SystemKey: "core", Name: "Core", ParentRefType: "scope",
			}},
			Memberships: []db.ArchitectureProposalMembership{{
				FileID: &file.ID, RootID: root.ID, FilePath: file.RelPath,
				TargetSystemKey: "core", Disposition: "assign",
			}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	payload, err := json.Marshal(map[string]any{
		"workspaceId": "ws", "revision": proposal.CurrentRevision,
		"decidedBy": "max", "establishDeltaBaseline": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	server.handleArchitectureProposalByID(
		response,
		httptest.NewRequest(http.MethodPost, "/api/architecture-proposals/proposal/finalize", bytes.NewReader(payload)),
	)
	if response.Code != http.StatusOK {
		t.Fatalf("finalize status %d: %s", response.Code, response.Body.String())
	}
	var body struct {
		DeltaBaselineAt int64 `json:"deltaBaselineAt"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	watermark, err := db.GetDeltaReviewedAtForRoot(sqlDB, "ws", root.ID)
	if err != nil {
		t.Fatal(err)
	}
	if body.DeltaBaselineAt == 0 || watermark != body.DeltaBaselineAt || watermark <= oldWatermark {
		t.Fatalf("setup baseline = body:%d stored:%d old:%d", body.DeltaBaselineAt, watermark, oldWatermark)
	}
	if events, err := db.GetStructuralEventsForRoot(sqlDB, "ws", root.ID, root.Branch, watermark); err != nil || len(events) != 0 {
		t.Fatalf("reviewed setup events survived baseline: events=%#v err=%v", events, err)
	}
	if snapshot, err := db.GetDeltaSnapshotForRoot(sqlDB, "ws", root.ID, root.Branch, watermark); err != nil || snapshot == "" {
		t.Fatalf("baseline snapshot missing: snapshot=%q err=%v", snapshot, err)
	}

	if err := db.RecordStructuralEvent(sqlDB, db.StructuralEvent{
		WorkspaceID: "ws", RootID: root.ID, TS: watermark + 1,
		Kind: db.EventFileUpdated, SubjectID: file.ID, SubjectLabel: file.RelPath,
	}); err != nil {
		t.Fatal(err)
	}
	events, err := db.GetStructuralEventsForRoot(sqlDB, "ws", root.ID, root.Branch, watermark)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].SubjectID != file.ID {
		t.Fatalf("post-review change was hidden: %#v", events)
	}
}
