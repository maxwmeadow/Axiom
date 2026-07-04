// Investigation Capture HTTP endpoints (plan Phase 8). Bridges the MCP tools /
// canvas to the runtime recorder and persists saved investigations.
//
//	POST   /api/investigation/start   {workspaceId, name?}   — begin recording
//	POST   /api/investigation/note    {workspaceId, text}    — annotate timeline
//	POST   /api/investigation/stop    {workspaceId}          — finalize + persist
//	GET    /api/investigation/list?workspace=                — saved investigations
//	GET    /api/investigation/<id>                           — full AxiomTrace doc
//	DELETE /api/investigation/<id>?workspace=                — delete
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"axiom.local/archd/internal/db"
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
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "bad request", 400)
		return
	}
	commit, branch := s.gitInfo(body.WorkspaceID)
	inv := s.runtime.StartInvestigation(body.WorkspaceID, body.Name, commit, branch)
	jsonOK(w, map[string]any{
		"id":     inv.ID,
		"name":   inv.Name,
		"commit": inv.Commit,
		"branch": inv.Branch,
		"note":   "Recording started. All traces, watches, values, perturbations, and notes are now captured. Call stop_investigation to save a shareable capture.",
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
	if !s.runtime.AnnotateInvestigation(body.WorkspaceID, body.Text) {
		jsonError(w, "no investigation is recording — call start_investigation first", 409)
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
	// Validate the DB is reachable BEFORE finalizing — otherwise stopping would
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
		inv.CreatedAt, inv.DurationMs, len(inv.Events), data); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}

	jsonOK(w, map[string]any{
		"id":         inv.ID,
		"name":       inv.Name,
		"eventCount": len(inv.Events),
		"durationMs": inv.DurationMs,
		"commit":     inv.Commit,
		"note":       "Investigation saved. Share id " + inv.ID + " — open it on the canvas to replay the whole investigation step by step.",
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
