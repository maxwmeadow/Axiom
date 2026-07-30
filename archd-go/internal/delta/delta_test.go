package delta

import (
	"testing"

	"axiom.local/archd/internal/db"
)

func fileEvent(ts int64, kind, id, relPath, actor, detail string) db.StructuralEvent {
	return db.StructuralEvent{
		TS: ts, Kind: kind, SubjectID: id, SubjectLabel: relPath,
		Actor: actor, Detail: detail, Count: 1,
	}
}

func edgeEvent(ts int64, kind, src, dst, srcLabel, dstLabel, actor, detail string) db.StructuralEvent {
	return db.StructuralEvent{
		TS: ts, Kind: kind, SubjectID: src, SubjectLabel: srcLabel,
		ObjectID: dst, ObjectLabel: dstLabel, Actor: actor, Detail: detail, Count: 1,
	}
}

func findFile(t *testing.T, summary Summary, id string) FileChange {
	t.Helper()
	for _, f := range summary.Files {
		if f.ID == id {
			return f
		}
	}
	t.Fatalf("expected file %q in delta, got %+v", id, summary.Files)
	return FileChange{}
}

func TestCreatedThenDeletedIsNotReported(t *testing.T) {
	summary := Aggregate([]db.StructuralEvent{
		fileEvent(10, db.EventFileCreated, "f1", "scratch.py", ActorAgent, ""),
		fileEvent(20, db.EventFileUpdated, "f1", "scratch.py", ActorAgent, ""),
		fileEvent(30, db.EventFileDeleted, "f1", "scratch.py", ActorAgent, ""),
	}, 0, 100)

	if len(summary.Files) != 0 {
		t.Fatalf("transient file should cancel out, got %+v", summary.Files)
	}
	if !summary.Empty {
		t.Fatal("a delta of only transient churn must report empty")
	}
}

func TestCreateWinsOverSubsequentEdits(t *testing.T) {
	summary := Aggregate([]db.StructuralEvent{
		fileEvent(10, db.EventFileCreated, "f1", "task.py", ActorAgent, `{"language":"python"}`),
		fileEvent(20, db.EventFileUpdated, "f1", "task.py", ActorAgent, ""),
		fileEvent(30, db.EventFileUpdated, "f1", "task.py", ActorAgent, ""),
	}, 0, 100)

	file := findFile(t, summary, "f1")
	if file.Change != ChangeCreated {
		t.Fatalf("a file created then edited is created, got %q", file.Change)
	}
	if file.Language != "python" {
		t.Fatalf("detail language lost: %+v", file)
	}
	if summary.Counts.FilesCreated != 1 || summary.Counts.FilesUpdated != 0 {
		t.Fatalf("counts should credit creation only: %+v", summary.Counts)
	}
}

func TestDeletedFileKeepsItsLastKnownSystem(t *testing.T) {
	summary := Aggregate([]db.StructuralEvent{
		fileEvent(10, db.EventFileUpdated, "f1", "store.py", ActorAgent,
			`{"systemId":"s1","systemName":"Storage"}`),
		fileEvent(20, db.EventFileDeleted, "f1", "store.py", ActorAgent, ""),
	}, 0, 100)

	file := findFile(t, summary, "f1")
	if file.Change != ChangeDeleted {
		t.Fatalf("expected deleted, got %q", file.Change)
	}
	if file.SystemName != "Storage" {
		t.Fatalf("a removed file must still report which system lost it: %+v", file)
	}
}

func TestRecreatedPathIsNotAGhost(t *testing.T) {
	summary := Aggregate([]db.StructuralEvent{
		fileEvent(10, db.EventFileDeleted, "f1", "task.py", ActorAgent, ""),
		fileEvent(20, db.EventFileCreated, "f1", "task.py", ActorAgent, ""),
	}, 0, 100)

	file := findFile(t, summary, "f1")
	if file.Change != ChangeCreated {
		t.Fatalf("a path deleted then rewritten still exists; got %q", file.Change)
	}
}

func TestRepeatedSavesCollapseButAccumulate(t *testing.T) {
	events := []db.StructuralEvent{
		fileEvent(10, db.EventFileUpdated, "f1", "task.py", ActorHuman, ""),
		fileEvent(20, db.EventFileUpdated, "f1", "task.py", ActorHuman, ""),
	}
	events[0].Count = 4
	summary := Aggregate(events, 0, 100)

	file := findFile(t, summary, "f1")
	if file.Saves != 5 {
		t.Fatalf("collapsed journal counts must accumulate, got %d", file.Saves)
	}
	if summary.Counts.FilesUpdated != 1 {
		t.Fatalf("one file changed, got %+v", summary.Counts)
	}
}

func TestNetChangeWithMultipleSessionsDoesNotMisquoteEitherAgent(t *testing.T) {
	events := []db.StructuralEvent{
		fileEvent(10, db.EventFileUpdated, "f1", "task.py", ActorAgent, ""),
		fileEvent(20, db.EventFileUpdated, "f1", "task.py", ActorAgent, ""),
	}
	events[0].SessionID = "work-a"
	events[1].SessionID = "work-b"
	summary := Aggregate(events, 0, 100)

	file := findFile(t, summary, "f1")
	if file.SessionID != "" {
		t.Fatalf("one net change cannot truthfully use either session's narration: %+v", file)
	}
}

func TestMixedActorReportsBoth(t *testing.T) {
	summary := Aggregate([]db.StructuralEvent{
		fileEvent(10, db.EventFileUpdated, "f1", "task.py", ActorAgent, ""),
		fileEvent(20, db.EventFileUpdated, "f1", "task.py", ActorHuman, ""),
	}, 0, 100)

	file := findFile(t, summary, "f1")
	if file.Actor != ActorBoth {
		t.Fatalf("a file both touched must report both, got %q", file.Actor)
	}
	if summary.Counts.AgentFiles != 1 || summary.Counts.HumanFiles != 1 {
		t.Fatalf("both actors should be credited: %+v", summary.Counts)
	}
}

func TestEdgeAddedThenRemovedCancels(t *testing.T) {
	detail := `{"relationship":"CALLS","callerSymbol":"a","calleeSymbol":"b"}`
	summary := Aggregate([]db.StructuralEvent{
		edgeEvent(10, db.EventEdgeAdded, "f1", "f2", "a.py", "b.py", ActorAgent, detail),
		edgeEvent(20, db.EventEdgeRemoved, "f1", "f2", "a.py", "b.py", ActorAgent, detail),
	}, 0, 100)

	if len(summary.Edges) != 0 {
		t.Fatalf("net-zero topology churn must not appear: %+v", summary.Edges)
	}
}

func TestCrossBoundaryEdgesLeadTheDelta(t *testing.T) {
	internal := `{"relationship":"CALLS","srcSystem":"s1","dstSystem":"s1"}`
	crossing := `{"relationship":"CALLS","srcSystem":"s1","dstSystem":"s2"}`
	summary := Aggregate([]db.StructuralEvent{
		edgeEvent(30, db.EventEdgeAdded, "f1", "f2", "a.py", "b.py", ActorAgent, internal),
		edgeEvent(10, db.EventEdgeAdded, "f1", "f3", "a.py", "c.py", ActorAgent, crossing),
	}, 0, 100)

	if len(summary.Edges) != 2 {
		t.Fatalf("expected both edges, got %+v", summary.Edges)
	}
	if !summary.Edges[0].Cross {
		t.Fatalf("cross-boundary edge must sort first, got %+v", summary.Edges)
	}
	if summary.Counts.CrossBoundary != 1 {
		t.Fatalf("expected one cross-boundary edge, got %+v", summary.Counts)
	}
}

func TestDistinctCallSymbolsAreDistinctEdges(t *testing.T) {
	summary := Aggregate([]db.StructuralEvent{
		edgeEvent(10, db.EventEdgeAdded, "f1", "f2", "a.py", "b.py", ActorAgent,
			`{"relationship":"CALLS","callerSymbol":"one","calleeSymbol":"x"}`),
		edgeEvent(20, db.EventEdgeRemoved, "f1", "f2", "a.py", "b.py", ActorAgent,
			`{"relationship":"CALLS","callerSymbol":"two","calleeSymbol":"y"}`),
	}, 0, 100)

	if len(summary.Edges) != 2 {
		t.Fatalf("different call sites must not cancel each other: %+v", summary.Edges)
	}
}

func TestSystemLifecycleNets(t *testing.T) {
	summary := Aggregate([]db.StructuralEvent{
		{TS: 10, Kind: db.EventSystemCreated, SubjectID: "s1", SubjectLabel: "Storage", Actor: ActorAgent},
		{TS: 20, Kind: db.EventSystemCreated, SubjectID: "s2", SubjectLabel: "Temp", Actor: ActorAgent},
		{TS: 30, Kind: db.EventSystemDeleted, SubjectID: "s2", SubjectLabel: "Temp", Actor: ActorAgent},
	}, 0, 100)

	if len(summary.Systems) != 1 || summary.Systems[0].ID != "s1" {
		t.Fatalf("only the surviving system belongs in the delta: %+v", summary.Systems)
	}
	if summary.Counts.SystemsAdded != 1 || summary.Counts.SystemsRemoved != 0 {
		t.Fatalf("unexpected counts: %+v", summary.Counts)
	}
}

func TestEmptyJournalIsAnEmptyDelta(t *testing.T) {
	summary := Aggregate(nil, 0, 100)
	if !summary.Empty {
		t.Fatal("no events means nothing to review")
	}
	if summary.Files == nil || summary.Edges == nil || summary.Systems == nil {
		t.Fatal("collections must marshal as [] rather than null")
	}
}
