package api

import (
	"database/sql"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"axiom.local/archd/internal/db"
	"axiom.local/archd/internal/delta"
)

type commandDeckStatus struct {
	WorkspaceID      string                    `json:"workspaceId"`
	Indexed          bool                      `json:"indexed"`
	Files            int                       `json:"files"`
	Systems          int                       `json:"systems"`
	UnreviewedClaims int                       `json:"unreviewedClaims"`
	Unexplained      int                       `json:"unexplained"`
	Unexpected       int                       `json:"unexpected"`
	ActiveWork       []db.WorkSession          `json:"activeWork"`
	OpenPlans        int                       `json:"openPlans"`
	PendingProposals int                       `json:"pendingProposals"`
	LastActivityAt   int64                     `json:"lastActivityAt"`
	Branches         []commandDeckBranchStatus `json:"branches"`
}

type commandDeckBranchStatus struct {
	RootID           string           `json:"rootId"`
	Branch           string           `json:"branch"`
	HeadCommit       string           `json:"headCommit"`
	IsPrimary        bool             `json:"isPrimary"`
	Files            int              `json:"files"`
	Systems          int              `json:"systems"`
	UnreviewedClaims int              `json:"unreviewedClaims"`
	Unexplained      int              `json:"unexplained"`
	Unexpected       int              `json:"unexpected"`
	ActiveWork       []db.WorkSession `json:"activeWork"`
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
			Branches:    []commandDeckBranchStatus{},
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
		Branches:    []commandDeckBranchStatus{},
	}
	if files, err := db.GetFiles(sqlDB, workspaceID); err == nil {
		status.Files = len(files)
	}
	if systems, err := db.GetSystems(sqlDB, workspaceID); err == nil {
		status.Systems = len(systems)
	}

	if sessions, err := db.GetActiveWorkSessions(sqlDB, workspaceID); err == nil {
		status.ActiveWork = sessions
	}
	now := time.Now().UnixMilli()
	intents := dispatchedIntents(sqlDB, workspaceID)
	if roots, rootsErr := db.GetActiveRoots(sqlDB, workspaceID); rootsErr == nil && len(roots) > 0 {
		for _, root := range roots {
			branch := s.commandDeckBranch(sqlDB, root, now, intents)
			status.Branches = append(status.Branches, branch)
			status.UnreviewedClaims += branch.UnreviewedClaims
			status.Unexplained += branch.Unexplained
			status.Unexpected += branch.Unexpected
			if branch.LastActivityAt > status.LastActivityAt {
				status.LastActivityAt = branch.LastActivityAt
			}
		}
	} else {
		s.populateLegacyCommandDeckDelta(sqlDB, &status, now, intents)
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
	for _, session := range status.ActiveWork {
		if session.StartedAt > status.LastActivityAt {
			status.LastActivityAt = session.StartedAt
		}
	}
	jsonOK(w, status)
}

func (s *Server) commandDeckBranch(
	sqlDB *sql.DB,
	root db.Root,
	now int64,
	intents []delta.Intent,
) commandDeckBranchStatus {
	status := commandDeckBranchStatus{
		RootID: root.ID, Branch: root.Branch, HeadCommit: root.HeadCommit,
		IsPrimary: root.IsPrimary, ActiveWork: []db.WorkSession{},
	}
	if files, err := db.GetFilesByRoot(sqlDB, root.ID); err == nil {
		status.Files = len(files)
		systems := map[string]struct{}{}
		for _, file := range files {
			if file.SystemID != nil && *file.SystemID != "" {
				systems[*file.SystemID] = struct{}{}
			}
		}
		status.Systems = len(systems)
	}
	if sessions, err := db.GetActiveWorkSessionsForRoot(
		sqlDB, root.WorkspaceID, root.ID, root.Branch,
	); err == nil {
		status.ActiveWork = sessions
	}
	allEvents, err := db.GetStructuralEventsForRoot(
		sqlDB, root.WorkspaceID, root.ID, root.Branch, 0,
	)
	if err != nil {
		return status
	}
	for _, event := range allEvents {
		if event.TS > status.LastActivityAt {
			status.LastActivityAt = event.TS
		}
	}
	for _, session := range status.ActiveWork {
		if session.StartedAt > status.LastActivityAt {
			status.LastActivityAt = session.StartedAt
		}
	}
	since, _ := db.GetDeltaReviewedAtForRoot(sqlDB, root.WorkspaceID, root.ID)
	if since == 0 {
		since = now - firstReviewLookbackMs
	}
	events := make([]db.StructuralEvent, 0, len(allEvents))
	for _, event := range allEvents {
		if event.TS > since {
			events = append(events, event)
		}
	}
	summary := delta.Aggregate(events, since, now)
	claims := delta.BuildClaims(
		summary, s.systemTopologyForRoot(sqlDB, root.WorkspaceID, root.ID),
	)
	claims = delta.ClassifyIntentDrift(claims, intents)
	countCommandDeckClaims(
		claims, &status.UnreviewedClaims, &status.Unexplained, &status.Unexpected,
	)
	return status
}

func (s *Server) populateLegacyCommandDeckDelta(
	sqlDB *sql.DB,
	status *commandDeckStatus,
	now int64,
	intents []delta.Intent,
) {
	since, _ := db.GetDeltaReviewedAt(sqlDB, status.WorkspaceID)
	if since == 0 {
		since = now - firstReviewLookbackMs
	}
	if events, err := db.GetStructuralEvents(sqlDB, status.WorkspaceID, since); err == nil {
		summary := delta.Aggregate(events, since, now)
		claims := delta.BuildClaims(summary, s.systemTopology(sqlDB, status.WorkspaceID))
		claims = delta.ClassifyIntentDrift(claims, intents)
		countCommandDeckClaims(
			claims, &status.UnreviewedClaims, &status.Unexplained, &status.Unexpected,
		)
	}
	_ = sqlDB.QueryRow(`
		SELECT COALESCE(MAX(ts), 0) FROM structural_events WHERE workspace_id=?`,
		status.WorkspaceID,
	).Scan(&status.LastActivityAt)
}

func countCommandDeckClaims(
	claims []delta.Claim,
	unreviewed, unexplained, unexpected *int,
) {
	for _, claim := range claims {
		if claim.Internal {
			continue
		}
		(*unreviewed)++
		if claim.Actor == delta.ActorAgent && claim.SessionID == "" {
			(*unexplained)++
		}
		if claim.IntentStatus == "unexpected" {
			(*unexpected)++
		}
	}
}
