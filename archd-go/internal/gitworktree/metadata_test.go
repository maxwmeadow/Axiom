package gitworktree

import (
	"testing"
	"time"
)

func TestMetadataWatcherReportsBranchHeadChanges(t *testing.T) {
	primary, branch, _ := gitChangeFixture(t)
	watcher, err := WatchMetadata(primary)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = watcher.Close() })

	writeGitFile(t, branch, "agent.go", "package agent\n")
	runGit(t, branch, "add", "agent.go")
	runGit(t, branch, "commit", "-m", "agent change")

	select {
	case <-watcher.Changes():
	case err := <-watcher.Errors():
		t.Fatalf("watch Git metadata: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for branch head metadata change")
	}
}
