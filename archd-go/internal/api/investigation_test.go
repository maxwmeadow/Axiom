package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"axiom.local/archd/internal/hub"
	"axiom.local/archd/internal/runtime"
)

// investigationServer returns a server with one open workspace.
func investigationServer(t *testing.T) (*Server, string) {
	t.Helper()
	eventHub := hub.New()
	server := NewServer(t.TempDir(), eventHub, runtime.NewManager(eventHub))
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(openWorkspaceReq{WorkspaceID: "ws", Name: "ws", RootPath: root})
	response := httptest.NewRecorder()
	server.handleWorkspace(response, httptest.NewRequest(http.MethodPost, "/api/workspace", bytes.NewReader(payload)))
	if response.Code != http.StatusOK {
		t.Fatalf("open workspace = %d: %s", response.Code, response.Body.String())
	}
	t.Cleanup(func() { server.closeDB("ws") })
	return server, root
}

func listInvestigations(t *testing.T, server *Server) []map[string]any {
	t.Helper()
	response := httptest.NewRecorder()
	server.handleInvestigationList(response, httptest.NewRequest(http.MethodGet, "/api/investigation/list?workspace=ws", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("list = %d: %s", response.Code, response.Body.String())
	}
	var body struct {
		Investigations []map[string]any `json:"investigations"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body.Investigations
}

// An investigation lived only in memory until stop, so a crash - or an agent
// that simply never called stop - discarded the whole session with no trace.
func TestAnInterruptedRecordingSurvivesAndIsReportedInterrupted(t *testing.T) {
	server, _ := investigationServer(t)

	server.runtime.StartInvestigation("ws", "Checkout timeout", "abc1234", "main")
	if _, ok := server.runtime.AnnotateInvestigation("ws", "settle() returns unrounded cents"); !ok {
		t.Fatal("expected the note to be accepted while recording")
	}

	server.flushActiveInvestigations()

	found := listInvestigations(t, server)
	if len(found) != 1 {
		t.Fatalf("expected the in-progress recording to be persisted, got %d", len(found))
	}
	if found[0]["status"] != "recording" {
		t.Fatalf("a live recording should read as recording, got %v", found[0]["status"])
	}

	// Simulate losing the recorder without a stop: the row outlives it.
	server.runtime.StopInvestigation("ws")

	found = listInvestigations(t, server)
	if len(found) != 1 {
		t.Fatalf("the flushed recording must not vanish, got %d", len(found))
	}
	if found[0]["status"] != "interrupted" {
		t.Fatalf("a recording whose recorder is gone is interrupted, got %v", found[0]["status"])
	}
	if found[0]["name"] != "Checkout timeout" {
		t.Fatalf("the name should survive the flush, got %v", found[0]["name"])
	}
}

// A finished investigation is saved, not interrupted.
func TestAStoppedRecordingIsSaved(t *testing.T) {
	server, _ := investigationServer(t)
	server.runtime.StartInvestigation("ws", "Done properly", "abc1234", "main")
	_, _ = server.runtime.AnnotateInvestigation("ws", "found it")

	response := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]string{"workspaceId": "ws"})
	server.handleInvestigationStop(response, httptest.NewRequest(http.MethodPost, "/api/investigation/stop", bytes.NewReader(body)))
	if response.Code != http.StatusOK {
		t.Fatalf("stop = %d: %s", response.Code, response.Body.String())
	}

	found := listInvestigations(t, server)
	if len(found) != 1 || found[0]["status"] != "saved" {
		t.Fatalf("a stopped recording should be saved, got %#v", found)
	}
}
