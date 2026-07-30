package api

import (
	"net/http"
	"os"
	"path/filepath"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/delta"
)

type commandDeckStatus struct {
	WorkspaceID      string           `json:"workspaceId"`
	Indexed          bool             `json:"indexed"`
	Files            int              `json:"files"`
	Systems          int              `json:"systems"`
	UnreviewedClaims int              `json:"unreviewedClaims"`
	Unexplained      int              `json:"unexplained"`
	Unexpected       int              `json:"unexpected"`
	ActiveWork       []db.WorkSession `json:"activeWork"`
	OpenPlans        int              `json:"openPlans"`
	PendingProposals int              `json:"pendingProposals"`
	LastActivityAt   int64            `json:"lastActivityAt"`
}

// GET /api/command-deck?workspace=...
//
// The launcher is a daily dashboard, so it needs a small read model without
// registering/watching every recent project. Opening the existing per-project
// DB is safe and keeps this summary derived from the same durable truth as the
// Floor, Morning Delta, and Mission Control.
func (s *Server) handleCommandDeck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	workspaceID := r.URL.Query().Get("workspace")
	if workspaceID == "" {
		jsonError(w, "workspace is required", http.StatusBadRequest)
		return
	}
	dbPath := filepath.Join(s.dataDir, workspaceID, "axiom.db")
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		jsonOK(w, commandDeckStatus{
			WorkspaceID: workspaceID,
			ActiveWork:  []db.WorkSession{},
		})
		return
	}
	sqlDB, err := s.openDB(workspaceID)
	if err != nil {
		jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	status := commandDeckStatus{
		WorkspaceID: workspaceID,
		Indexed:     true,
		ActiveWork:  []db.WorkSession{},
	}
	if files, err := db.GetFiles(sqlDB, workspaceID); err == nil {
		status.Files = len(files)
	}
	if systems, err := db.GetSystems(sqlDB, workspaceID); err == nil {
		status.Systems = len(systems)
	}

	since, _ := db.GetDeltaReviewedAt(sqlDB, workspaceID)
	if since == 0 {
		since = time.Now().UnixMilli() - firstReviewLookbackMs
	}
	if events, err := db.GetStructuralEvents(sqlDB, workspaceID, since); err == nil {
		summary := delta.Aggregate(events, since, time.Now().UnixMilli())
		claims := delta.BuildClaims(summary, s.systemTopology(sqlDB, workspaceID))
		claims = delta.ClassifyIntentDrift(
			claims,
			dispatchedIntents(sqlDB, workspaceID),
		)
		for _, claim := range claims {
			if claim.Internal {
				continue
			}
			status.UnreviewedClaims++
			if claim.Actor == delta.ActorAgent && claim.SessionID == "" {
				status.Unexplained++
			}
			if claim.IntentStatus == "unexpected" {
				status.Unexpected++
			}
		}
	}
	if sessions, err := db.GetActiveWorkSessions(sqlDB, workspaceID); err == nil {
		status.ActiveWork = sessions
	}
	_ = sqlDB.QueryRow(`
		SELECT COUNT(*) FROM planned_nodes
		WHERE workspace_id=? AND approval_status='approved'
			AND status NOT IN ('realized','flattened')`,
		workspaceID,
	).Scan(&status.OpenPlans)
	_ = sqlDB.QueryRow(`
		SELECT COUNT(*) FROM planned_nodes
		WHERE workspace_id=? AND approval_status='pending'`,
		workspaceID,
	).Scan(&status.PendingProposals)
	_ = sqlDB.QueryRow(`
		SELECT COALESCE(MAX(ts), 0) FROM structural_events WHERE workspace_id=?`,
		workspaceID,
	).Scan(&status.LastActivityAt)
	for _, session := range status.ActiveWork {
		if session.StartedAt > status.LastActivityAt {
			status.LastActivityAt = session.StartedAt
		}
	}
	jsonOK(w, status)
}
