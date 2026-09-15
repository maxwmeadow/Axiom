package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"axiom.local/archd/internal/activity"
	"axiom.local/archd/internal/db"
)

// POST /api/agent/action - record one thing an agent did, and show it live.
// GET  /api/agent/actions?workspace=&since=&limit= - read the log back.
//
// This is the agent-visibility spine. Every MCP tool call lands here from a
// single wrapper in the MCP server, so a tool added later is logged without
// anyone remembering to instrument it.
//
// Recording is best-effort by design: a failure to log must never fail the
// agent's actual work.
func (s *Server) handleAgentAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var request struct {
		db.AgentAction
		Cwd string `json:"cwd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		jsonError(w, "invalid body", 400)
		return
	}
	body := request.AgentAction
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}
	if body.RootID == "" && request.Cwd != "" {
		if root, matched, resolveErr := resolveWorkspaceRootForCwd(
			sqlDB, body.WorkspaceID, request.Cwd,
		); resolveErr != nil {
			jsonError(w, resolveErr.Error(), http.StatusInternalServerError)
			return
		} else if matched {
			body.RootID, body.Branch = root.ID, root.Branch
		}
	}

	// Attribute the action to whatever work the agent declared it was doing,
	// so the log groups into tasks rather than reading as a flat firehose.
	if body.SessionID == "" {
		body.SessionID = db.ActiveWorkSessionIDForRoot(sqlDB, body.WorkspaceID, body.RootID)
	}
	activity.MarkAgent(body.WorkspaceID)

	action, err := db.RecordAgentAction(sqlDB, body)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}

	// The renderer animates from this: targets tell the canvas which nodes to
	// light up, kind tells it how.
	s.hub.Broadcast("agent:action", action)

	// An agent should not have to remember to press record. If it starts
	// investigating and nothing is recording, Axiom starts one itself.
	s.maybeAutoStartInvestigation(sqlDB, action)

	jsonOK(w, action)
}

func (s *Server) handleAgentActions(w http.ResponseWriter, r *http.Request) {
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
	var since int64
	if raw := r.URL.Query().Get("since"); raw != "" {
		fmt.Sscanf(raw, "%d", &since)
	}
	limit := 200
	if raw := r.URL.Query().Get("limit"); raw != "" {
		fmt.Sscanf(raw, "%d", &limit)
	}
	if err := db.PruneAgentActions(sqlDB, workspaceID, time.Now().UnixMilli()); err != nil {
		log.Printf("api: prune agent log for %s: %v", workspaceID, err)
	}
	actions, err := db.GetAgentActions(sqlDB, workspaceID, since, limit)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	jsonOK(w, actions)
}

// handleCallTrace animates and records a trace the caller assembled itself.
//
// POST /api/call-trace {workspaceId, steps}
//
// /api/call-path walks the graph here and broadcasts what it finds, but the
// call-graph shape - the one agents are told to use for "the graph around
// these files" - is assembled in the MCP from SQL and had no way to reach the
// canvas. So it drew nothing, and an investigation recorded a prose line
// instead of the trace itself.
func (s *Server) handleCallTrace(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string        `json:"workspaceId"`
		Steps       []db.CallEdge `json:"steps"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid body", 400)
		return
	}
	if body.WorkspaceID == "" || len(body.Steps) == 0 {
		jsonError(w, "workspaceId and a non-empty steps array are required", 400)
		return
	}
	s.hub.Broadcast("call:trace", map[string]any{
		"workspaceId": body.WorkspaceID,
		"steps":       body.Steps,
	})
	jsonOK(w, map[string]any{"steps": len(body.Steps)})
}
