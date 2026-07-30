package indexer

import (
	"os"
	"path/filepath"
	"testing"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/hub"
)

func TestTwelveFilePythonProjectBuildsStructuralEvidenceAndVisibleSystems(t *testing.T) {
	sqlDB, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	projectDir := t.TempDir()
	fixture := map[string]string{
		"main.py": `from integrations import EmailClient, SlackClient
from services.reporting import summarize
from services.task_service import TaskService


if __name__ == "__main__":
    service = TaskService()
    task_one = service.create_task("Write project scaffold")
    service.create_task("Review task model")
    service.create_task("Wire service layer")
    service.complete_task(task_one.id)
    print(summarize(service.store))
`,
		"integrations/__init__.py": `from .email_client import EmailClient
from .slack_client import SlackClient
`,
		"integrations/email_client.py": `class EmailClient:
    def send(self, to: str, subject: str, body: str) -> None:
        return None
`,
		"integrations/slack_client.py": `class SlackClient:
    def post_message(self, channel: str, message: str) -> None:
        return None
`,
		"models/__init__.py": `from .task import Task
from .priority import Priority
`,
		"models/task.py": `from dataclasses import dataclass
from datetime import datetime

@dataclass
class Task:
    id: str
    title: str
    status: str
    created_at: datetime
`,
		"models/priority.py": `class Priority:
    LOW = "low"
    HIGH = "high"
`,
		"services/__init__.py": `from .task_service import TaskService
`,
		"services/task_service.py": `from models.task import Task
from storage.task_store import TaskStore

class TaskService:
    def __init__(self, store: TaskStore | None = None) -> None:
        self.store = store or TaskStore()

    def create_task(self, title: str, status: str = "todo") -> Task:
        task = Task(title=title, status=status)
        return self.store.add(task)

    def complete_task(self, task_id: str) -> Task | None:
        task = self.store.get(task_id)
        if task is None:
            return None
        task.status = "done"
        return task
`,
		"services/reporting.py": `from storage.task_store import TaskStore

def summarize(store: TaskStore) -> str:
    tasks = store.list()
    return str(len(tasks))
`,
		"storage/__init__.py": `from .task_store import TaskStore
`,
		"storage/task_store.py": `from models.task import Task

class TaskStore:
    def add(self, task: Task) -> Task:
        return task

    def get(self, task_id: str) -> Task | None:
        return None

    def list(self) -> list[Task]:
        return []
`,
	}
	for relPath, content := range fixture {
		writeFixtureFile(t, projectDir, relPath, content)
	}

	root := db.Root{ID: "root", WorkspaceID: "ws", Path: projectDir}
	if err := db.UpsertWorkspace(sqlDB, db.Workspace{ID: "ws", Name: "semantic-fixture"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRoot(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	if err := IndexRoot(sqlDB, hub.New(), root, nil); err != nil {
		t.Fatal(err)
	}

	files, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != len(fixture) {
		t.Fatalf("indexed %d files, want %d", len(files), len(fixture))
	}
	dependencies, err := db.GetDependencies(sqlDB, root.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	if len(dependencies) < 12 {
		t.Fatalf("resolved only %d Python imports; want at least 12 structural edges", len(dependencies))
	}

	systems, err := db.GetSystems(sqlDB, root.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	if len(systems) == 0 {
		t.Fatal("semantic evidence should produce at least one system")
	}
	for _, system := range systems {
		parent := "root"
		if system.ParentID != nil {
			parent = *system.ParentID
		}
		t.Logf("system %q id=%s parent=%s", system.Name, system.ID, parent)
	}
	for _, file := range files {
		parent := "root"
		if file.SystemID != nil {
			parent = *file.SystemID
		}
		t.Logf("file %s parent=%s", file.RelPath, parent)
	}
	directMembers := make(map[string]int)
	for _, file := range files {
		if file.SystemID != nil {
			directMembers[*file.SystemID]++
		}
	}
	childSystems := make(map[string]int)
	for _, system := range systems {
		if system.ParentID != nil {
			childSystems[*system.ParentID]++
		}
	}
	for _, system := range systems {
		if directMembers[system.ID] == 0 && childSystems[system.ID] == 0 {
			t.Fatalf("system %q (%s) has no visible file or child-system content", system.Name, system.ID)
		}
	}

	byPath := make(map[string]db.File, len(files))
	systemByID := make(map[string]db.System, len(systems))
	for _, file := range files {
		byPath[file.RelPath] = file
	}
	for _, system := range systems {
		systemByID[system.ID] = system
	}
	taskSystemID := topSystemID(t, requiredSystemID(t, byPath["models/task.py"]), systemByID)
	for _, relPath := range []string{"services/task_service.py", "storage/task_store.py"} {
		directID := requiredSystemID(t, byPath[relPath])
		if got := topSystemID(t, directID, systemByID); got != taskSystemID {
			t.Fatalf("task naming/dependency evidence split %s from the task system", relPath)
		}
	}
	if got := systemByID[taskSystemID].Name; got != "Task" {
		t.Fatalf("cross-directory task system name = %q, want Task", got)
	}
	clientSystemID := topSystemID(t, requiredSystemID(t, byPath["integrations/email_client.py"]), systemByID)
	slackSystemID := topSystemID(t, requiredSystemID(t, byPath["integrations/slack_client.py"]), systemByID)
	if slackSystemID != clientSystemID {
		t.Fatal("shared client naming evidence did not group email and Slack clients")
	}
	if got := systemByID[clientSystemID].Name; got != "Client" {
		t.Fatalf("client system name = %q, want Client", got)
	}
	if taskSystemID == clientSystemID {
		t.Fatal("unrelated task and client concerns were merged")
	}

	before := make(map[string]string, len(files))
	var assignedFile db.File
	for _, file := range files {
		systemID := ""
		if file.SystemID != nil {
			systemID = *file.SystemID
			assignedFile = file
		}
		before[file.ID] = systemID
	}
	if assignedFile.ID == "" {
		t.Fatal("fixture produced no assigned file")
	}

	// Reproduce the persisted contradiction from the reported project: the DB
	// says the file belongs to a system while an old floor layout keeps it root.
	if _, err := sqlDB.Exec(`
		INSERT INTO floor_layouts
			(workspace_id,node_id,node_type,parent_node_id,parent_node_type,containment_kind,
			 position_x,position_y,width,height,scale,updated_at)
		VALUES (?,?, 'file',NULL,NULL,'root',28,54,240,120,1,1)`,
		root.WorkspaceID, assignedFile.ID,
	); err != nil {
		t.Fatal(err)
	}

	if err := ClusterOnly(sqlDB, root); err != nil {
		t.Fatal(err)
	}
	after, err := db.GetFilesByRoot(sqlDB, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range after {
		systemID := ""
		if file.SystemID != nil {
			systemID = *file.SystemID
		}
		if before[file.ID] != systemID {
			t.Fatalf("stable reopen changed %s membership: %q -> %q",
				file.RelPath, before[file.ID], systemID)
		}
	}
	var staleLayout int
	if err := sqlDB.QueryRow(`
		SELECT COUNT(*) FROM floor_layouts
		WHERE workspace_id=? AND node_type='file' AND node_id=?`,
		root.WorkspaceID, assignedFile.ID,
	).Scan(&staleLayout); err != nil {
		t.Fatal(err)
	}
	if staleLayout != 0 {
		t.Fatal("contradictory root layout survived semantic classification")
	}
}

func requiredSystemID(t *testing.T, file db.File) string {
	t.Helper()
	if file.ID == "" {
		t.Fatal("fixture file was not indexed")
	}
	if file.SystemID == nil {
		t.Fatalf("%s was left unclassified", file.RelPath)
	}
	return *file.SystemID
}

func topSystemID(t *testing.T, systemID string, systems map[string]db.System) string {
	t.Helper()
	seen := make(map[string]bool)
	for {
		if seen[systemID] {
			t.Fatalf("system ancestry cycle at %s", systemID)
		}
		seen[systemID] = true
		system, ok := systems[systemID]
		if !ok {
			t.Fatalf("system %s not found", systemID)
		}
		if system.ParentID == nil {
			return systemID
		}
		systemID = *system.ParentID
	}
}

func writeFixtureFile(t *testing.T, root, relPath, content string) {
	t.Helper()
	absPath := filepath.Join(root, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(absPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
