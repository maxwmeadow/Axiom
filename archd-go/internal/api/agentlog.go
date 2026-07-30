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

// POST /api/agent/action — record one thing an agent did, and show it live.
// GET  /api/agent/actions?workspace=&since=&limit= — read the log back.
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
	var body db.AgentAction
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid body", 400)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), 404)
		return
	}

	// Attribute the action to whatever work the agent declared it was doing,
	// so the log groups into tasks rather than reading as a flat firehose.
	if body.SessionID == "" {
		body.SessionID = db.ActiveWorkSessionID(sqlDB, body.WorkspaceID)
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
