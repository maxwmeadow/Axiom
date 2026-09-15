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

	server.runtime.StartInvestigation("ws", "Checkout timeout", "abc1234", "main", "agent")
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
	server.runtime.StartInvestigation("ws", "Done properly", "abc1234", "main", "agent")
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

// postAction drives the same handler every MCP tool call lands in.
func postAction(t *testing.T, server *Server, tool, kind, sessionID string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"workspaceId": "ws", "tool": tool, "kind": kind,
		"sessionId": sessionID, "agent": "test-agent", "status": "ok",
	})
	response := httptest.NewRecorder()
	server.handleAgentAction(response, httptest.NewRequest(http.MethodPost, "/api/agent/action", bytes.NewReader(body)))
	if response.Code != http.StatusOK {
		t.Fatalf("agent action = %d: %s", response.Code, response.Body.String())
	}
}

// An agent should not have to remember to press record.
func TestSustainedTracingStartsARecordingOnItsOwn(t *testing.T) {
	server, _ := investigationServer(t)

	postAction(t, server, "trace_calls", "trace", "")
	if server.runtime.ActiveInvestigation("ws") != nil {
		t.Fatal("one incidental trace must not start an investigation")
	}

	postAction(t, server, "get_data_flow", "trace", "")
	active := server.runtime.ActiveInvestigation("ws")
	if active == nil {
		t.Fatal("sustained tracing should have started a recording")
	}
	if active.Origin != "auto" {
		t.Fatalf("origin = %q, want auto", active.Origin)
	}
}

// Listing captures is 'debug' too; counting it would let reading about
// investigations create one.
func TestTheRecordersOwnToolsDoNotStartARecording(t *testing.T) {
	server, _ := investigationServer(t)
	postAction(t, server, "investigation", "debug", "")
	postAction(t, server, "investigation", "debug", "")
	if server.runtime.ActiveInvestigation("ws") != nil {
		t.Fatal("the recorder's own tools must not trigger auto-capture")
	}
}

func TestAutoCaptureDoesNotDisturbARecordingAlreadyRunning(t *testing.T) {
	server, _ := investigationServer(t)
	started := server.runtime.StartInvestigation("ws", "Asked for", "sha", "main", "agent")

	postAction(t, server, "trace_calls", "trace", "")
	postAction(t, server, "get_data_flow", "trace", "")

	active := server.runtime.ActiveInvestigation("ws")
	if active == nil || active.ID != started.ID {
		t.Fatalf("the explicit recording should still be the active one, got %#v", active)
	}
	if active.Origin != "agent" {
		t.Fatalf("origin = %q, want agent", active.Origin)
	}
}

// A recording Axiom started ends when the agent moves on. One that was asked
// for does not - ending it is the caller's decision.
func TestAnIdleSelfStartedRecordingClosesItselfButAnAskedForOneDoesNot(t *testing.T) {
	server, _ := investigationServer(t)
	server.autoCaptureIdleStop = 0 // anything idle at all is idle enough

	postAction(t, server, "trace_calls", "trace", "")
	postAction(t, server, "get_data_flow", "trace", "")
	if server.runtime.ActiveInvestigation("ws") == nil {
		t.Fatal("expected a self-started recording")
	}

	server.flushActiveInvestigations()
	if server.runtime.ActiveInvestigation("ws") != nil {
		t.Fatal("an idle self-started recording should have closed itself")
	}
	found := listInvestigations(t, server)
	if len(found) != 1 || found[0]["status"] != "saved" || found[0]["origin"] != "auto" {
		t.Fatalf("expected one saved auto capture, got %#v", found)
	}

	// An explicitly requested recording is left alone.
	server.runtime.StartInvestigation("ws", "Asked for", "sha", "main", "agent")
	_, _ = server.runtime.AnnotateInvestigation("ws", "still working")
	server.flushActiveInvestigations()
	if server.runtime.ActiveInvestigation("ws") == nil {
		t.Fatal("an asked-for recording must not be closed by a timeout")
	}
}

// The ordinary sequence: Axiom notices the agent tracing and starts recording,
// then the agent calls start itself. Replacing would throw away the traces that
// prompted the investigation in the first place.
func TestAnExplicitStartAdoptsTheRecordingAxiomAlreadyBegan(t *testing.T) {
	server, _ := investigationServer(t)

	postAction(t, server, "trace_calls", "trace", "")
	postAction(t, server, "get_data_flow", "trace", "")
	auto := server.runtime.ActiveInvestigation("ws")
	if auto == nil || auto.Origin != "auto" {
		t.Fatalf("expected a self-started recording, got %#v", auto)
	}
	_, _ = server.runtime.AnnotateInvestigation("ws", "captured before the agent asked")

	body, _ := json.Marshal(map[string]string{"workspaceId": "ws", "name": "Checkout timeout"})
	response := httptest.NewRecorder()
	server.handleInvestigationStart(response, httptest.NewRequest(http.MethodPost, "/api/investigation/start", bytes.NewReader(body)))
	if response.Code != http.StatusOK {
		t.Fatalf("start = %d: %s", response.Code, response.Body.String())
	}

	active := server.runtime.ActiveInvestigation("ws")
	if active == nil || active.ID != auto.ID {
		t.Fatalf("the explicit start should continue the same recording, got %#v", active)
	}
	if active.Origin != "agent" {
		t.Fatalf("origin = %q, want agent after adoption", active.Origin)
	}
	if active.Name != "Checkout timeout" {
		t.Fatalf("name = %q, want the agent's name", active.Name)
	}
	if active.EventCount == 0 {
		t.Fatal("adoption must keep what was already captured")
	}
}

// Adoption must never rename a recording its owner is already running.
func TestAnExplicitStartDoesNotAdoptAnotherExplicitRecording(t *testing.T) {
	server, _ := investigationServer(t)
	first := server.runtime.StartInvestigation("ws", "Mine", "sha", "main", "human")
	if adopted := server.runtime.AdoptAutoInvestigation("ws", "Theirs", "agent"); adopted != nil {
		t.Fatalf("an explicit recording must not be adopted, got %#v", adopted)
	}
	active := server.runtime.ActiveInvestigation("ws")
	if active.ID != first.ID || active.Name != "Mine" || active.Origin != "human" {
		t.Fatalf("the original recording should be untouched, got %#v", active)
	}
}

// The canvas animates call:trace, and the recorder captures it. A trace the
// MCP assembled had no way to reach either.
func TestAnAssembledTraceAnimatesAndIsCaptured(t *testing.T) {
	server, _ := investigationServer(t)
	server.runtime.StartInvestigation("ws", "Assembled trace", "sha", "main", "agent")

	steps := []map[string]any{{
		"callerFile": "file-a", "callerSymbol": "charge",
		"calleeFile": "file-b", "calleeSymbol": "settle", "callCount": 1,
	}}
	body, _ := json.Marshal(map[string]any{"workspaceId": "ws", "steps": steps})
	response := httptest.NewRecorder()
	server.handleCallTrace(response, httptest.NewRequest(http.MethodPost, "/api/call-trace", bytes.NewReader(body)))
	if response.Code != http.StatusOK {
		t.Fatalf("call-trace = %d: %s", response.Code, response.Body.String())
	}

	inv := server.runtime.StopInvestigation("ws")
	if inv == nil {
		t.Fatal("expected the recording to still be active")
	}
	found := false
	for _, event := range inv.Events {
		if event.Type == "call:trace" {
			found = true
		}
	}
	if !found {
		t.Fatalf("an assembled trace must land on the timeline, got %d events", len(inv.Events))
	}
}

func TestAnEmptyAssembledTraceIsRejected(t *testing.T) {
	server, _ := investigationServer(t)
	body, _ := json.Marshal(map[string]any{"workspaceId": "ws", "steps": []any{}})
	response := httptest.NewRecorder()
	server.handleCallTrace(response, httptest.NewRequest(http.MethodPost, "/api/call-trace", bytes.NewReader(body)))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for an empty trace", response.Code)
	}
}
