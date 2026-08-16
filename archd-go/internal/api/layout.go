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
		WorkspaceID string              `json:"workspaceId"`
		Layouts     []db.FloorLayout    `json:"layouts"`
		Remove      []db.FloorLayoutRef `json:"remove"`
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
	if err := db.RemoveFloorLayouts(sqlDB, body.WorkspaceID, body.Remove); err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}
	// A batch that only withdraws geometry is a legitimate request; requiring an
	// update alongside it would force callers to invent one.
	if len(body.Layouts) == 0 {
		layouts, err := db.GetFloorLayouts(sqlDB, body.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), http.StatusInternalServerError)
			return
		}
		result := &db.FloorLayoutBatchResult{Layouts: layouts}
		s.broadcastPatch("floor:layouts", result)
		jsonOK(w, result)
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
