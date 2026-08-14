package api

import (
	"encoding/json"
	"net/http"
	"sort"
)

// AgentPresence is one running MCP process with a renewable connection lease.
// HostID identifies the harness when Axiom installed it; "unknown" preserves
// compatibility with manually configured and older MCP entries.
type AgentPresence struct {
	ConnectionID string `json:"connectionId"`
	HostID       string `json:"hostId"`
	LastSeenAt   int64  `json:"lastSeenAt"`
}

func (s *Server) handleAgentPresence(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		var body struct {
			WorkspaceID  string `json:"workspaceId"`
			ConnectionID string `json:"connectionId"`
			HostID       string `json:"hostId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "invalid body", http.StatusBadRequest)
			return
		}
		if body.WorkspaceID == "" || body.ConnectionID == "" {
			jsonError(w, "workspaceId and connectionId are required", http.StatusBadRequest)
			return
		}
		if body.HostID == "" {
			body.HostID = "unknown"
		}
		presence := AgentPresence{
			ConnectionID: body.ConnectionID,
			HostID:       body.HostID,
			LastSeenAt:   s.presenceNow().UnixMilli(),
		}
		s.presenceMu.Lock()
		connections := s.agentPresence[body.WorkspaceID]
		if connections == nil {
			connections = make(map[string]AgentPresence)
			s.agentPresence[body.WorkspaceID] = connections
		}
		_, existed := connections[body.ConnectionID]
		connections[body.ConnectionID] = presence
		s.presenceMu.Unlock()
		jsonOK(w, map[string]any{
			"connectionId": presence.ConnectionID,
			"hostId":       presence.HostID,
			"lastSeenAt":   presence.LastSeenAt,
			"newLease":     !existed,
		})

	case http.MethodGet:
		workspaceID := r.URL.Query().Get("workspace")
		if workspaceID == "" {
			jsonError(w, "workspace is required", http.StatusBadRequest)
			return
		}
		cutoff := s.presenceNow().Add(-s.agentPresenceTTL).UnixMilli()
		active := []AgentPresence{}
		s.presenceMu.Lock()
		connections := s.agentPresence[workspaceID]
		for id, presence := range connections {
			if presence.LastSeenAt < cutoff {
				delete(connections, id)
				continue
			}
			active = append(active, presence)
		}
		if len(connections) == 0 {
			delete(s.agentPresence, workspaceID)
		}
		s.presenceMu.Unlock()
		sort.Slice(active, func(i, j int) bool {
			if active[i].HostID == active[j].HostID {
				return active[i].ConnectionID < active[j].ConnectionID
			}
			return active[i].HostID < active[j].HostID
		})
		jsonOK(w, map[string]any{
			"connected":   len(active) > 0,
			"connections": active,
		})

	default:
		http.NotFound(w, r)
	}
}
