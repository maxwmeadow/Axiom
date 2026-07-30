package indexer

import (
	"database/sql"
	"path/filepath"
	"testing"

	"axiom.local/archd/internal/db"
)

func TestLiveClassificationIsSemanticStableAndProtectsAuthoredIntent(t *testing.T) {
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	projectDir := t.TempDir()
	root := db.Root{ID: "root", WorkspaceID: "ws", Path: projectDir}
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}

	manualID := "manual-system"
	if err := db.UpsertSystem(sqlDB, db.System{
		ID: manualID, WorkspaceID: "ws", Name: "Hand Authored", Source: "user",
	}); err != nil {
		t.Fatal(err)
	}
	seedIndexedFile(t, sqlDB, root, "manual-file", "manual/locked.py", &manualID)

	seedIndexedFile(t, sqlDB, root, "loose", "services/loose.py", nil)
	changed, err := ClusterLive(sqlDB, root)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("a lone unclassified file should remain visible at the root")
	}

	// Folder placement deliberately contradicts the semantic dependency pairs.
	// The classifier must group across folders, never recreate services/models.
	seedIndexedFile(t, sqlDB, root, "order-api", "services/order_api.py", nil)
	seedIndexedFile(t, sqlDB, root, "order-store", "models/order_store.py", nil)
	seedIndexedFile(t, sqlDB, root, "billing-api", "models/billing_api.py", nil)
	seedIndexedFile(t, sqlDB, root, "billing-store", "services/billing_store.py", nil)
	seedDependency(t, sqlDB, "order-api", "order-store")
	seedDependency(t, sqlDB, "billing-api", "billing-store")

	changed, err = ClusterLive(sqlDB, root)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("semantic relationship evidence should trigger live classification")
	}

	orderSystemID := fileSystemID(t, sqlDB, "order-api")
	if got := fileSystemID(t, sqlDB, "order-store"); got != orderSystemID {
		t.Fatalf("order dependency pair split across systems: %s != %s", orderSystemID, got)
	}
	billingSystemID := fileSystemID(t, sqlDB, "billing-api")
	if got := fileSystemID(t, sqlDB, "billing-store"); got != billingSystemID {
		t.Fatalf("billing dependency pair split across systems: %s != %s", billingSystemID, got)
	}
	if orderSystemID == billingSystemID {
		t.Fatal("disconnected semantic communities were merged")
	}
	orderSystem := mustSystem(t, sqlDB, orderSystemID)
	billingSystem := mustSystem(t, sqlDB, billingSystemID)
	if orderSystem.Source != "cluster" || billingSystem.Source != "cluster" {
		t.Fatalf("inferred systems should remain provisional: %#v %#v", orderSystem, billingSystem)
	}
	if orderSystem.Name == "services" || orderSystem.Name == "models" ||
		billingSystem.Name == "services" || billingSystem.Name == "models" {
		t.Fatalf("folder name leaked into semantic system labels: %#v %#v", orderSystem, billingSystem)
	}
	if got := fileSystemID(t, sqlDB, "manual-file"); got != manualID {
		t.Fatalf("authored containment changed: got %s want %s", got, manualID)
	}

	layoutResult, err := db.ApplyFloorLayoutBatch(sqlDB, "ws", []db.FloorLayout{{
		NodeID: orderSystemID, NodeType: "system",
		PositionX: 140, PositionY: 90, Width: 520, Height: 360, Scale: 1,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if layoutResult.Revision != 1 {
		t.Fatalf("layout revision = %d, want 1", layoutResult.Revision)
	}

	// Simulate a stale pre-migration layout that still renders an assigned file
	// at the root. Classification must remove this contradiction even when the
	// semantic system assignment itself remains stable.
	if _, err := sqlDB.Exec(`
		INSERT INTO floor_layouts
			(workspace_id,node_id,node_type,parent_node_id,parent_node_type,containment_kind,
			 position_x,position_y,width,height,scale,updated_at)
		VALUES ('ws','order-api','file',NULL,NULL,'root',28,54,240,120,1,1)`); err != nil {
		t.Fatal(err)
	}

	if err := clusterAndAssign(sqlDB, root, false); err != nil {
		t.Fatal(err)
	}
	if got := fileSystemID(t, sqlDB, "order-api"); got != orderSystemID {
		t.Fatalf("stable semantic system identity changed: %s -> %s", orderSystemID, got)
	}
	layouts, err := db.GetFloorLayouts(sqlDB, "ws")
	if err != nil {
		t.Fatal(err)
	}
	if len(layouts) != 1 || layouts[0].NodeID != orderSystemID {
		t.Fatalf("stable recluster lost authored layout: %#v", layouts)
	}

	// Confirming a proposal promotes it to authored intent. Later classifier
	// passes may reconcile auto-owned systems but must never rewrite this one.
	orderSystem = mustSystem(t, sqlDB, orderSystemID)
	orderSystem.Source = "user"
	if err := db.UpsertSystem(sqlDB, orderSystem); err != nil {
		t.Fatal(err)
	}
	seedIndexedFile(t, sqlDB, root, "new-loose", "random/new_loose.py", nil)
	changed, err = ClusterLive(sqlDB, root)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("new unclassified file should trigger reconciliation")
	}
	confirmed := mustSystem(t, sqlDB, orderSystemID)
	if confirmed.Source != "user" {
		t.Fatalf("confirmed system was overwritten: %#v", confirmed)
	}
	if got := fileSystemID(t, sqlDB, "order-api"); got != orderSystemID {
		t.Fatalf("confirmed membership changed: got %s want %s", got, orderSystemID)
	}
}

func TestClusterScopeProtectsClusterDescendantsOfAuthoredSystems(t *testing.T) {
	userID := "user"
	childID := "cluster-child"
	files := []db.File{
		{ID: "loose"},
		{ID: "protected", SystemID: &childID},
	}
	systems := []db.System{
		{ID: userID, Source: "user"},
		{ID: childID, Source: "cluster", ParentID: &userID},
	}

	managed, pruneable := clusterScope(files, systems)
	if len(managed) != 1 || managed[0].ID != "loose" {
		t.Fatalf("managed files = %#v, want only loose", managed)
	}
	if _, ok := pruneable[childID]; ok {
		t.Fatal("cluster descendant inside authored system must not be pruned")
	}
}

func seedIndexedFile(t *testing.T, sqlDB *sql.DB, root db.Root, id, relPath string, systemID *string) {
	t.Helper()
	if err := db.UpsertFile(sqlDB, db.File{
		ID: id, RootID: root.ID, Path: filepath.Join(root.Path, filepath.FromSlash(relPath)),
		RelPath: relPath, Language: "python", SystemID: systemID, LineCount: 10,
	}); err != nil {
		t.Fatal(err)
	}
}

func seedDependency(t *testing.T, sqlDB *sql.DB, src, dst string) {
	t.Helper()
	if err := db.UpsertDependency(sqlDB, db.Dependency{
		ID: src + "-" + dst, WorkspaceID: "ws", Src: src, Dst: dst,
		SrcType: "file", DstType: "file", DependencyType: "IMPORTS",
	}); err != nil {
		t.Fatal(err)
	}
}

func fileSystemID(t *testing.T, sqlDB *sql.DB, fileID string) string {
	t.Helper()
	file, err := db.GetFileByID(sqlDB, fileID)
	if err != nil {
		t.Fatal(err)
	}
	if file == nil || file.SystemID == nil {
		return ""
	}
	return *file.SystemID
}

func mustSystem(t *testing.T, sqlDB *sql.DB, systemID string) db.System {
	t.Helper()
	system, err := db.GetSystem(sqlDB, systemID)
	if err != nil {
		t.Fatal(err)
	}
	if system == nil {
		t.Fatalf("system %s not found", systemID)
	}
	return *system
}
