// Investigation Capture HTTP endpoints (plan Phase 8). Bridges the MCP tools /
// canvas to the runtime recorder and persists saved investigations.
//
//	POST   /api/investigation/start   {workspaceId, name?}   - begin recording
//	POST   /api/investigation/note    {workspaceId, text}    - annotate timeline
//	POST   /api/investigation/stop    {workspaceId}          - finalize + persist
//	GET    /api/investigation/list?workspace=                - saved investigations
//	GET    /api/investigation/<id>                           - full AxiomTrace doc
//	DELETE /api/investigation/<id>?workspace=                - delete
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/runtime"
)

func (s *Server) registerInvestigationRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/investigation/start", s.handleInvestigationStart)
	mux.HandleFunc("/api/investigation/note", s.handleInvestigationNote)
	mux.HandleFunc("/api/investigation/stop", s.handleInvestigationStop)
	mux.HandleFunc("/api/investigation/list", s.handleInvestigationList)
	mux.HandleFunc("/api/investigation/", s.handleInvestigationByID)
}

func (s *Server) handleInvestigationStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Name        string `json:"name"`
		Origin      string `json:"origin"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	commit, branch := s.gitInfo(body.WorkspaceID)
	// The MCP tool sends no origin, so an agent asking is the default; the
	// record button says 'human' for itself.
	origin := body.Origin
	if origin == "" {
		origin = "agent"
	}
	// Axiom may already be recording because it saw this agent start tracing.
	// Adopt that rather than replacing it, so the work leading up to this call
	// stays in the capture.
	adopted := false
	inv := s.runtime.AdoptAutoInvestigation(body.WorkspaceID, body.Name, origin)
	if inv != nil {
		adopted = true
	} else {
		inv = s.runtime.StartInvestigation(body.WorkspaceID, body.Name, commit, branch, origin)
	}
	note := "Recording started. All traces, watches, values, perturbations, and notes are now captured. " +
		"Add a note at each finding, and call stop when you have the answer - stop saves a shareable capture."
	if adopted {
		note = "Axiom had already started recording when it saw you investigating, so this " +
			"continues that capture - the work you did before this call is already in it. " +
			"Add a note at each finding, and call stop when you have the answer."
	}
	if commit == "" && !adopted {
		// Replay renders code from the pinned commit. Without one it still
		// replays, but cannot guarantee the reader sees the same source.
		note += " This workspace has no resolvable git commit, so the capture will not be pinned to a code version."
	}
	jsonOK(w, map[string]any{
		"id":     inv.ID,
		"name":   inv.Name,
		"commit": inv.Commit,
		"branch": inv.Branch,
		"note":   note,
	})
}

func (s *Server) handleInvestigationNote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		Text        string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	if body.Text == "" {
		jsonError(w, "text is required", 400)
		return
	}
	if _, ok := s.runtime.AnnotateInvestigation(body.WorkspaceID, body.Text); !ok {
		jsonError(w, "no investigation is recording - call start_investigation first", 409)
		return
	}
	jsonOK(w, map[string]any{"noted": true})
}

func (s *Server) handleInvestigationStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	// Validate the DB is reachable BEFORE finalizing - otherwise stopping would
	// discard the in-memory recording with nowhere to persist it.
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}

	inv := s.runtime.StopInvestigation(body.WorkspaceID)
	if inv == nil {
		jsonError(w, "no investigation is recording", 409)
		return
	}

	// Attach the current canvas snapshot so a fresh viewer can position nodes
	// even if the live graph later changes.
	if snap, err := db.GetCanvasSnapshot(sqlDB, body.WorkspaceID); err == nil && snap != nil {
		if raw, err := json.Marshal(snap); err == nil {
			inv.CanvasSnapshot = raw
		}
	}
	data, err := json.Marshal(inv)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	if err := db.SaveInvestigation(sqlDB, inv.ID, inv.WorkspaceID, inv.Name, inv.Commit, inv.Branch,
		"saved", inv.Origin, inv.CreatedAt, inv.DurationMs, len(inv.Events), data); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}

	jsonOK(w, map[string]any{
		"id":         inv.ID,
		"name":       inv.Name,
		"eventCount": len(inv.Events),
		"durationMs": inv.DurationMs,
		"commit":     inv.Commit,
		"note":       "Investigation saved. Share id " + inv.ID + " - open it on the canvas to replay the whole investigation step by step.",
	})
}

func (s *Server) handleInvestigationList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	list, err := db.ListInvestigations(sqlDB, workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	// Surface the currently-recording investigation, if any.
	active := s.runtime.ActiveInvestigation(workspaceID)
	activeID := ""
	if active != nil {
		activeID = active.ID
	}
	for i := range list {
		if list[i].Status == "recording" && list[i].ID != activeID {
			list[i].Status = "interrupted"
		}
	}
	jsonOK(w, map[string]any{"investigations": list, "recording": active})
}

func (s *Server) handleInvestigationByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/investigation/")
	if id == "" || strings.Contains(id, "/") {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	switch r.Method {
	case http.MethodGet:
		data, err := db.GetInvestigation(sqlDB, id)
		if err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		if data == nil {
			jsonError(w, "investigation not found", 404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(data)
	case http.MethodDelete:
		if err := db.DeleteInvestigation(sqlDB, id); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		jsonOK(w, map[string]any{"deleted": id})
	default:
		http.NotFound(w, r)
	}
}

// gitInfo returns the current commit SHA and branch of the workspace's first
// root, or empty strings if git is unavailable / the root isn't a repo.
func (s *Server) gitInfo(workspaceID string) (commit, branch string) {
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		return "", ""
	}
	roots, err := db.GetRoots(sqlDB, workspaceID)
	if err != nil || len(roots) == 0 {
		return "", ""
	}
	dir := roots[0].Path
	commit = gitCmd(dir, "rev-parse", "HEAD")
	branch = gitCmd(dir, "rev-parse", "--abbrev-ref", "HEAD")
	return commit, branch
}

func gitCmd(dir string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// runInvestigationFlusher periodically persists in-progress recordings.
//
// Events live in memory until stop, so before this existed a crash, a quit, or
// an agent that simply never called stop discarded the entire session with no
// trace. Flushed rows are written with status 'recording'; the list handler
// reports any that outlived their recorder as 'interrupted'.
func (s *Server) runInvestigationFlusher(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		s.flushActiveInvestigations()
	}
}

// flushActiveInvestigations writes every in-progress recording to disk once.
func (s *Server) flushActiveInvestigations() {
	{
		for _, workspaceID := range s.runtime.ActiveInvestigationWorkspaces() {
			// A recording Axiom started ends when the agent stops working.
			if idle, origin, recording := s.runtime.InvestigationIdleFor(workspaceID); recording &&
				origin == "auto" && idle > s.autoCaptureIdleStop {
				_, _ = s.finalizeInvestigation(workspaceID)
				continue
			}
			inv := s.runtime.ActiveInvestigationSnapshot(workspaceID)
			if inv == nil || len(inv.Events) == 0 {
				continue
			}
			sqlDB, err := s.dbFor(workspaceID)
			if err != nil {
				continue
			}
			data, err := json.Marshal(inv)
			if err != nil {
				continue
			}
			_ = db.SaveInvestigation(sqlDB, inv.ID, inv.WorkspaceID, inv.Name, inv.Commit, inv.Branch,
				"recording", inv.Origin, inv.CreatedAt, inv.DurationMs, len(inv.Events), data)
		}
	}
}

const (
	// Two qualifying actions inside this window mean the agent is investigating
	// rather than incidentally tracing one thing while building a feature.
	autoCaptureWindow    = 90 * time.Second
	autoCaptureThreshold = 2
	// A recording Axiom started closes itself once the agent moves on. One that
	// was explicitly asked for never does - ending it is the caller's decision.
	autoCaptureIdleStopDefault = 3 * time.Minute
)

// maybeAutoStartInvestigation begins a recording when an agent's own activity
// shows it has started investigating. Best-effort: failing to record must never
// affect the agent's work.
func (s *Server) maybeAutoStartInvestigation(sqlDB *sql.DB, action db.AgentAction) {
	if action.WorkspaceID == "" {
		return
	}
	if action.Kind != "trace" && action.Kind != "debug" {
		return
	}
	// The recorder's own tools are 'debug' too. Counting them would let
	// "list my investigations" twice start an investigation.
	if strings.Contains(action.Tool, "investigation") {
		return
	}
	if s.runtime.ActiveInvestigation(action.WorkspaceID) != nil {
		return
	}

	now := time.Now().UnixMilli()
	cutoff := now - autoCaptureWindow.Milliseconds()
	s.autoCaptureMu.Lock()
	recent := append(s.autoCaptureRecent[action.WorkspaceID], now)
	kept := recent[:0]
	for _, ts := range recent {
		if ts >= cutoff {
			kept = append(kept, ts)
		}
	}
	s.autoCaptureRecent[action.WorkspaceID] = kept
	enough := len(kept) >= autoCaptureThreshold
	s.autoCaptureMu.Unlock()
	if !enough {
		return
	}

	// Name it after what the agent said it was doing, so the capture reads as
	// a task rather than a timestamp.
	name := "Agent investigation"
	if action.SessionID != "" {
		if session, err := db.GetWorkSession(sqlDB, action.WorkspaceID, action.SessionID); err == nil && session.Goal != "" {
			name = session.Goal
		}
	}
	commit, branch := s.gitInfo(action.WorkspaceID)
	s.runtime.StartInvestigation(action.WorkspaceID, name, commit, branch, "auto")
}

// finalizeInvestigation stops the active recording and persists it. Shared by
// the stop endpoint and by the idle auto-stop so both produce the same document.
func (s *Server) finalizeInvestigation(workspaceID string) (*runtime.Investigation, error) {
	sqlDB, err := s.dbFor(workspaceID)
	if err != nil {
		return nil, err
	}
	inv := s.runtime.StopInvestigation(workspaceID)
	if inv == nil {
		return nil, nil
	}
	if snap, snapErr := db.GetCanvasSnapshot(sqlDB, workspaceID); snapErr == nil && snap != nil {
		if raw, marshalErr := json.Marshal(snap); marshalErr == nil {
			inv.CanvasSnapshot = raw
		}
	}
	data, err := json.Marshal(inv)
	if err != nil {
		return inv, err
	}
	if err := db.SaveInvestigation(sqlDB, inv.ID, inv.WorkspaceID, inv.Name, inv.Commit, inv.Branch,
		"saved", inv.Origin, inv.CreatedAt, inv.DurationMs, len(inv.Events), data); err != nil {
		return inv, err
	}
	return inv, nil
}
