package delta

import (
	"strings"
	"testing"
)

func crossEdge(src, dst, srcSys, dstSys, caller, callee string) EdgeChange {
	return EdgeChange{
		SrcID: src, DstID: dst, SrcLabel: src, DstLabel: dst,
		Change: ChangeAdded, Relationship: "CALLS",
		CallerSymbol: caller, CalleeSymbol: callee,
		SrcSystemID: srcSys, DstSystemID: dstSys,
		SrcSystem: strings.Title(srcSys), DstSystem: strings.Title(dstSys),
		Cross: srcSys != dstSys && srcSys != "" && dstSys != "",
		Actor: ActorAgent, TS: 10,
	}
}

func importEdge(src, dst, srcSys, dstSys string) EdgeChange {
	edge := crossEdge(src, dst, srcSys, dstSys, "", "")
	edge.Relationship = "IMPORTS"
	return edge
}

func findClaim(t *testing.T, claims []Claim, kind ClaimKind) Claim {
	t.Helper()
	for _, claim := range claims {
		if claim.Kind == kind {
			return claim
		}
	}
	t.Fatalf("no %s claim in %+v", kind, claims)
	return Claim{}
}

// The failure that motivated claims: one architectural fact arriving as five
// rows because it had five call sites and a coincident import.
func TestOneDependencyIsOneClaimRegardlessOfCallSites(t *testing.T) {
	claims := BuildClaims(Summary{
		Edges: []EdgeChange{
			crossEdge("handlers.py", "task_store.py", "api", "storage", "handle_get", "get"),
			crossEdge("handlers.py", "task_store.py", "api", "storage", "handle_get", "TaskStore"),
			importEdge("handlers.py", "task_store.py", "api", "storage"),
		},
	}, nil)

	coupling := []Claim{}
	for _, claim := range claims {
		if claim.Kind == ClaimCoupling {
			coupling = append(coupling, claim)
		}
	}
	if len(coupling) != 1 {
		t.Fatalf("one new dependency must be one claim, got %d: %+v", len(coupling), coupling)
	}
	if coupling[0].Title != "Api now depends on Storage" {
		t.Fatalf("title should name the systems, got %q", coupling[0].Title)
	}
	// The import is explained by the calls between the same files, so it must
	// not appear as separate evidence.
	if len(coupling[0].Evidence) != 2 {
		t.Fatalf("expected the two call sites only, got %+v", coupling[0].Evidence)
	}
	if coupling[0].Subtitle != "2 call sites" {
		t.Fatalf("subtitle should count evidence, got %q", coupling[0].Subtitle)
	}
}

func TestAnImportWithoutACallStillCountsAsEvidence(t *testing.T) {
	claims := BuildClaims(Summary{
		Edges: []EdgeChange{importEdge("a.py", "b.py", "api", "storage")},
	}, nil)

	coupling := findClaim(t, claims, ClaimCoupling)
	if len(coupling.Evidence) != 1 || coupling.Evidence[0].Kind != "import" {
		t.Fatalf("a bare import is the only evidence there is: %+v", coupling.Evidence)
	}
}

// The bug Max caught: an unclassified file has no boundary to cross.
func TestUnclassifiedEndpointIsNotABoundaryCrossing(t *testing.T) {
	edge := crossEdge("cache.py", "record.py", "", "storage", "put", "Record")
	edge.Unclassified = true
	edge.Cross = false

	claims := BuildClaims(Summary{
		Edges: []EdgeChange{edge},
		Files: []FileChange{{
			ID: "cache.py", RelPath: "storage/cache.py",
			Change: ChangeCreated, Actor: ActorAgent, TS: 10,
		}},
	}, nil)

	for _, claim := range claims {
		if claim.Kind == ClaimCoupling {
			t.Fatalf("an unplaced file cannot couple systems: %+v", claim)
		}
	}
	unclassified := findClaim(t, claims, ClaimUnclassified)
	if unclassified.Title != "1 file awaiting classification" {
		t.Fatalf("unexpected title %q", unclassified.Title)
	}
}

func TestTwentyFilesImportingOneModuleIsOneClaim(t *testing.T) {
	edges := []EdgeChange{}
	for i := 0; i < 20; i++ {
		edges = append(edges, importEdge(
			"billing/f"+string(rune('a'+i))+".py", "db/connection.py", "billing", "database"))
	}
	claims := BuildClaims(Summary{Edges: edges}, nil)

	coupling := findClaim(t, claims, ClaimCoupling)
	if len(coupling.Evidence) != 1 {
		t.Fatalf("imports collapse into one evidence row, got %+v", coupling.Evidence)
	}
	if coupling.Evidence[0].Label != "20 files newly imported" {
		t.Fatalf("evidence should report the scale, got %q", coupling.Evidence[0].Label)
	}
}

func TestCycleOutranksEverything(t *testing.T) {
	// Storage already reaches Api through Web, so Api → Storage closes a loop.
	topology := SystemTopology{
		"storage": {"web": true},
		"web":     {"api": true},
	}
	claims := BuildClaims(Summary{
		Edges: []EdgeChange{
			crossEdge("handlers.py", "task_store.py", "api", "storage", "handle_get", "get"),
		},
		Systems: []SystemChange{{
			ID: "new", Name: "Reporting", Change: ChangeCreated, Actor: ActorAgent, TS: 20,
		}},
	}, topology)

	if !claims[0].CreatesCycle {
		t.Fatalf("a cycle must lead the delta, got %+v", claims[0])
	}
	if !strings.HasPrefix(claims[0].Title, "Cycle:") {
		t.Fatalf("a cycle must say so, got %q", claims[0].Title)
	}
	if claims[0].Severity != cycleSeverity {
		t.Fatalf("expected cycle severity, got %d", claims[0].Severity)
	}
}

func TestACouplingIsNotACycleWhenOnlyTheDirectEdgeConnectsThem(t *testing.T) {
	// storage → api exists ONLY as the reverse of the edge being judged.
	topology := SystemTopology{"storage": {"api": true}}
	claims := BuildClaims(Summary{
		Edges: []EdgeChange{crossEdge("h.py", "t.py", "api", "storage", "a", "b")},
	}, topology)

	if claims[0].CreatesCycle {
		t.Fatal("the edge under review must not be counted as its own return path")
	}
}

func TestInternalChurnIsCollapsedAndDemoted(t *testing.T) {
	claims := BuildClaims(Summary{
		Files: []FileChange{
			{ID: "f1", RelPath: "api/a.py", Change: ChangeUpdated, Saves: 3, SystemID: "api", SystemName: "Api", TS: 30},
			{ID: "f2", RelPath: "api/b.py", Change: ChangeUpdated, Saves: 1, SystemID: "api", SystemName: "Api", TS: 20},
		},
		Edges: []EdgeChange{{
			SrcID: "f1", DstID: "f2", Change: ChangeAdded, Relationship: "CALLS",
			SrcSystemID: "api", DstSystemID: "api", SrcSystem: "Api", DstSystem: "Api",
			Cross: false, Actor: ActorAgent, TS: 25,
		}},
		Systems: []SystemChange{{ID: "s9", Name: "Reporting", Change: ChangeCreated, TS: 5}},
	}, nil)

	internal := findClaim(t, claims, ClaimInternal)
	if !internal.Internal {
		t.Fatal("intra-system churn must be flagged for hiding by default")
	}
	if internal.Title != "Api · 2 files edited" {
		t.Fatalf("unexpected title %q", internal.Title)
	}
	if claims[len(claims)-1].Kind != ClaimInternal {
		t.Fatalf("internal churn must sort last, got %+v", claims[len(claims)-1])
	}
	if claims[0].Kind != ClaimSystemAdded {
		t.Fatalf("a new system should outrank internal churn, got %+v", claims[0])
	}
}

func TestMembershipGroupsFilesBySystem(t *testing.T) {
	claims := BuildClaims(Summary{
		Files: []FileChange{
			{ID: "f1", RelPath: "storage/cache.py", Change: ChangeCreated, SystemID: "st", SystemName: "Storage", Actor: ActorAgent, TS: 30},
			{ID: "f2", RelPath: "storage/pool.py", Change: ChangeCreated, SystemID: "st", SystemName: "Storage", Actor: ActorAgent, TS: 31},
			{ID: "f3", RelPath: "api/serializers.py", Change: ChangeDeleted, SystemID: "ap", SystemName: "Api", Actor: ActorAgent, TS: 32},
		},
	}, nil)

	var storage, api Claim
	for _, claim := range claims {
		if claim.Kind != ClaimMembership {
			continue
		}
		if strings.HasPrefix(claim.Title, "Storage") {
			storage = claim
		}
		if strings.HasPrefix(claim.Title, "Api") {
			api = claim
		}
	}
	if storage.Title != "Storage gained 2 files" {
		t.Fatalf("unexpected storage title %q", storage.Title)
	}
	if len(storage.Evidence) != 2 {
		t.Fatalf("both files are evidence: %+v", storage.Evidence)
	}
	if api.Title != "Api lost 1 file" {
		t.Fatalf("unexpected api title %q", api.Title)
	}
}

func TestASingleNewFileNamesItself(t *testing.T) {
	claims := BuildClaims(Summary{
		Files: []FileChange{{
			ID: "f1", RelPath: "storage/cache.py", Change: ChangeCreated,
			SystemID: "st", SystemName: "Storage", Actor: ActorAgent, TS: 30,
		}},
	}, nil)

	membership := findClaim(t, claims, ClaimMembership)
	if membership.Title != "Storage gained storage/cache.py" {
		t.Fatalf("one file should be named, not counted: %q", membership.Title)
	}
}

func TestBoundaryClaimsFrameBothSystems(t *testing.T) {
	claims := BuildClaims(Summary{
		Edges: []EdgeChange{crossEdge("h.py", "t.py", "api", "storage", "a", "b")},
	}, nil)

	coupling := findClaim(t, claims, ClaimCoupling)
	if len(coupling.FocusSystemIDs) != 2 {
		t.Fatalf("the boundary is the claim; both systems must be framed: %+v", coupling.FocusSystemIDs)
	}
}

func TestEvidenceWeightIsSublinear(t *testing.T) {
	one := score(7, 1)
	fifty := score(7, 50)
	if fifty <= one {
		t.Fatal("more evidence should rank higher")
	}
	if fifty > one*2 {
		t.Fatalf("fifty call sites must not be fifty times a single one: %f vs %f", fifty, one)
	}
}

func TestHubTransitionRequiresAnExactBeforeAfterThresholdCrossing(t *testing.T) {
	before := &ArchitectureSnapshot{
		Systems: map[string]string{
			"core": "Core", "a": "A", "b": "B", "c": "C",
		},
		Topology: SystemTopology{
			"core": {"a": true, "b": true},
		},
	}
	after := &ArchitectureSnapshot{
		Systems: before.Systems,
		Topology: SystemTopology{
			"core": {"a": true, "b": true, "c": true},
		},
	}
	summary := Summary{Edges: []EdgeChange{
		crossEdge("core/new.py", "c/api.py", "core", "c", "run", "serve"),
	}}

	claims := BuildClaimsWithSnapshots(summary, before, after)
	hub := findClaim(t, claims, ClaimHubTransition)
	if hub.Title != "Core became an architectural hub" {
		t.Fatalf("unexpected hub title %q", hub.Title)
	}
	if hub.Subtitle != "now connects 3 systems (was 2)" {
		t.Fatalf("unexpected hub consequence %q", hub.Subtitle)
	}
	if claims[0].Kind != ClaimHubTransition {
		t.Fatalf("hub transition should outrank its individual coupling: %+v", claims)
	}
}

func TestLosingTheFinalConnectionCreatesAnOrphanClaim(t *testing.T) {
	systems := map[string]string{"legacy": "Legacy", "core": "Core"}
	before := &ArchitectureSnapshot{
		Systems:  systems,
		Topology: SystemTopology{"legacy": {"core": true}},
	}
	after := &ArchitectureSnapshot{
		Systems:  systems,
		Topology: SystemTopology{},
	}
	removed := crossEdge("legacy/a.py", "core/b.py", "legacy", "core", "old", "run")
	removed.Change = ChangeRemoved

	claims := BuildClaimsWithSnapshots(
		Summary{Edges: []EdgeChange{removed}},
		before,
		after,
	)
	var orphan Claim
	for _, claim := range claims {
		if claim.ID == "claim:orphaned:legacy" {
			orphan = claim
			break
		}
	}
	if orphan.ID == "" {
		t.Fatalf("legacy orphan claim missing from %+v", claims)
	}
	if orphan.Title != "Legacy became disconnected" {
		t.Fatalf("unexpected orphan title %q", orphan.Title)
	}
	if orphan.Subtitle != "lost its final connection" {
		t.Fatalf("unexpected orphan consequence %q", orphan.Subtitle)
	}
}

func TestConsequencesAreNeverInferredWithoutBothSnapshots(t *testing.T) {
	after := &ArchitectureSnapshot{
		Systems:  map[string]string{"core": "Core", "a": "A", "b": "B", "c": "C"},
		Topology: SystemTopology{"core": {"a": true, "b": true, "c": true}},
	}
	claims := BuildClaimsWithSnapshots(Summary{}, nil, after)
	for _, claim := range claims {
		if claim.Kind == ClaimHubTransition || claim.Kind == ClaimOrphaned {
			t.Fatalf("snapshot consequence invented without a before graph: %+v", claim)
		}
	}
}
