package api

import (
	"encoding/json"
	"net/http"

	"axiom.local/archd/internal/db"
)

func (s *Server) handleFloorLayoutBatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body struct {
		WorkspaceID string           `json:"workspaceId"`
		Layouts     []db.FloorLayout `json:"layouts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid layout batch", http.StatusBadRequest)
		return
	}
	sqlDB, err := s.dbFor(body.WorkspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}
	result, err := db.ApplyFloorLayoutBatch(sqlDB, body.WorkspaceID, body.Layouts)
	if err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.broadcastPatch("floor:layouts", result)
	jsonOK(w, result)
}
