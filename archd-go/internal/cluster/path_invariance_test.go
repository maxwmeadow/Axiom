package cluster

import (
	"reflect"
	"testing"

	"axiom.local/archd/internal/db"
)

func TestClusterMembershipIsInvariantToDirectoryLayout(t *testing.T) {
	files := []db.File{
		{ID: "order-api", RelPath: "services/order_api.py"},
		{ID: "order-store", RelPath: "models/order_store.py"},
		{ID: "billing-api", RelPath: "services/billing_api.py"},
		{ID: "billing-store", RelPath: "models/billing_store.py"},
	}
	dependencies := []db.Dependency{
		{Src: "order-api", Dst: "order-store", DependencyType: "IMPORTS"},
		{Src: "billing-api", Dst: "billing-store", DependencyType: "IMPORTS"},
	}

	first := Cluster(ClusterInput{Files: files, Dependencies: dependencies})

	// Deliberately rearrange identical files into folders that imply the
	// opposite grouping. Semantic membership must remain unchanged.
	moved := append([]db.File(nil), files...)
	moved[0].RelPath = "left/order_api.py"
	moved[1].RelPath = "right/order_store.py"
	moved[2].RelPath = "right/billing_api.py"
	moved[3].RelPath = "left/billing_store.py"
	second := Cluster(ClusterInput{Files: moved, Dependencies: dependencies})

	if !reflect.DeepEqual(first, second) {
		t.Fatalf("directory relocation changed semantic communities: %#v -> %#v", first, second)
	}
	if first["order-api"] != first["order-store"] {
		t.Fatalf("order dependency pair split across systems: %#v", first)
	}
	if first["billing-api"] != first["billing-store"] {
		t.Fatalf("billing dependency pair split across systems: %#v", first)
	}
	if first["order-api"] == first["billing-api"] {
		t.Fatalf("disconnected semantic pairs were merged: %#v", first)
	}
}

func TestDirectorySimilarityAloneCreatesNoMembershipEdges(t *testing.T) {
	files := []db.File{
		{ID: "a", RelPath: "services/task_service.py"},
		{ID: "b", RelPath: "services/email_client.py"},
	}
	vectors := BuildTFIDF(files, map[string][]db.Symbol{})
	graph := buildGraph(ClusterInput{Files: files, TFIDF: vectors})
	if graph.totalW != 0 {
		t.Fatalf("shared directory created a classifier edge: weight=%f", graph.totalW)
	}
}

func TestFilenameConventionsCreateSemanticEvidenceAcrossDirectories(t *testing.T) {
	files := []db.File{
		{ID: "service", RelPath: "services/task_service.py"},
		{ID: "store", RelPath: "models/task_store.py"},
		{ID: "client", RelPath: "services/email_client.py"},
	}
	vectors := BuildTFIDF(files, map[string][]db.Symbol{})
	graph := buildGraph(ClusterInput{Files: files, TFIDF: vectors})
	serviceIdx := graph.nodeIdx["service"]
	storeIdx := graph.nodeIdx["store"]
	clientIdx := graph.nodeIdx["client"]
	if graph.adj[serviceIdx][storeIdx] <= 0 {
		t.Fatal("shared authored filename term should create semantic evidence")
	}
	if graph.adj[serviceIdx][clientIdx] != 0 {
		t.Fatal("directory adjacency must not create evidence between unrelated names")
	}
}
