package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"axiom.local/archd/internal/db"
)

type createArchitectureProposalRequest struct {
	WorkspaceID string `json:"workspaceId"`
	db.ArchitectureProposal
}

type reviseArchitectureProposalRequest struct {
	WorkspaceID      string                       `json:"workspaceId"`
	ExpectedRevision int                          `json:"expectedRevision"`
	Round            db.ArchitectureProposalRound `json:"round"`
}

type decideArchitectureProposalSystemRequest struct {
	WorkspaceID     string `json:"workspaceId"`
	Revision        int    `json:"revision"`
	Decision        string `json:"decision"`
	RejectionReason string `json:"rejectionReason"`
	DecidedBy       string `json:"decidedBy"`
}

type saveArchitectureProposalLayoutsRequest struct {
	WorkspaceID string                          `json:"workspaceId"`
	Revision    int                             `json:"revision"`
	Layouts     []db.ArchitectureProposalLayout `json:"layouts"`
}

type finalizeArchitectureProposalRequest struct {
	WorkspaceID            string `json:"workspaceId"`
	Revision               int    `json:"revision"`
	DecidedBy              string `json:"decidedBy"`
	EstablishDeltaBaseline bool   `json:"establishDeltaBaseline"`
}

func (s *Server) registerArchitectureProposalRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/architecture-proposals", s.handleArchitectureProposals)
	mux.HandleFunc("/api/architecture-proposals/", s.handleArchitectureProposalByID)
}

func proposalErrorStatus(err error) int {
	if errors.Is(err, sql.ErrNoRows) {
		return http.StatusNotFound
	}
	message := err.Error()
	if strings.Contains(message, "stale proposal revision") || strings.Contains(message, "already ") || strings.Contains(message, "must be approved first") || strings.Contains(message, "UNIQUE constraint") {
		return http.StatusConflict
	}
	if strings.Contains(message, "required") || strings.Contains(message, "invalid") || strings.Contains(message, "does not exist") || strings.Contains(message, "does not belong") || strings.Contains(message, "unique file path") || strings.Contains(message, "proposal depth") || strings.Contains(message, "parent must") || strings.Contains(message, "not editable") || strings.Contains(message, "hierarchy cycle") {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

func (s *Server) handleArchitectureProposals(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		var request createArchitectureProposalRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			jsonError(w, "bad request", http.StatusBadRequest)
			return
		}
		request.ArchitectureProposal.WorkspaceID = request.WorkspaceID
		sqlDB, err := s.dbFor(request.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), http.StatusNotFound)
			return
		}
		proposal, err := db.CreateArchitectureProposal(sqlDB, request.ArchitectureProposal)
		if err != nil {
			jsonError(w, err.Error(), proposalErrorStatus(err))
			return
		}
		s.hub.Broadcast("architecture:proposal", map[string]any{"workspaceId": request.WorkspaceID, "proposalId": proposal.ID})
		jsonOK(w, proposal)
	case http.MethodGet:
		workspaceID := r.URL.Query().Get("workspace")
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), http.StatusNotFound)
			return
		}
		proposals, err := db.ListArchitectureProposals(sqlDB, workspaceID)
		if err != nil {
			jsonError(w, err.Error(), proposalErrorStatus(err))
			return
		}
		jsonOK(w, proposals)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handleArchitectureProposalByID(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/architecture-proposals/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	proposalID := parts[0]
	if r.Method == http.MethodGet && len(parts) == 1 {
		workspaceID := r.URL.Query().Get("workspace")
		includeRetained, _ := strconv.ParseBool(r.URL.Query().Get("includeRetained"))
		sqlDB, err := s.dbFor(workspaceID)
		if err != nil {
			jsonError(w, err.Error(), http.StatusNotFound)
			return
		}
		proposal, err := db.GetArchitectureProposal(sqlDB, proposalID, workspaceID, includeRetained)
		if err != nil {
			jsonError(w, err.Error(), proposalErrorStatus(err))
			return
		}
		jsonOK(w, proposal)
		return
	}
	if r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "revisions" {
		var request reviseArchitectureProposalRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			jsonError(w, "bad request", http.StatusBadRequest)
			return
		}
		sqlDB, err := s.dbFor(request.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), http.StatusNotFound)
			return
		}
		proposal, err := db.AddArchitectureProposalRevision(sqlDB, proposalID, request.WorkspaceID, request.ExpectedRevision, request.Round)
		if err != nil {
			jsonError(w, err.Error(), proposalErrorStatus(err))
			return
		}
		s.hub.Broadcast("architecture:proposal", map[string]any{"workspaceId": request.WorkspaceID, "proposalId": proposalID})
		jsonOK(w, proposal)
		return
	}
	if r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "layouts" {
		var request saveArchitectureProposalLayoutsRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			jsonError(w, "bad request", http.StatusBadRequest)
			return
		}
		sqlDB, err := s.dbFor(request.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), http.StatusNotFound)
			return
		}
		proposal, err := db.ApplyArchitectureProposalLayouts(sqlDB, proposalID, request.WorkspaceID, request.Revision, request.Layouts)
		if err != nil {
			jsonError(w, err.Error(), proposalErrorStatus(err))
			return
		}
		s.hub.Broadcast("architecture:proposal", map[string]any{"workspaceId": request.WorkspaceID, "proposalId": proposalID, "layout": true})
		jsonOK(w, proposal)
		return
	}
	if r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "finalize" {
		var request finalizeArchitectureProposalRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			jsonError(w, "bad request", http.StatusBadRequest)
			return
		}
		sqlDB, err := s.dbFor(request.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), http.StatusNotFound)
			return
		}
		proposal, err := db.FinalizeArchitectureProposal(sqlDB, proposalID, request.WorkspaceID, request.Revision, request.DecidedBy)
		if err != nil {
			jsonError(w, err.Error(), proposalErrorStatus(err))
			return
		}
		snapshot, err := db.GetCanvasSnapshot(sqlDB, request.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), proposalErrorStatus(err))
			return
		}
		var deltaBaselineAt int64
		var deltaRootID string
		if request.EstablishDeltaBaseline {
			rootID := ""
			if proposal.RootID != nil {
				rootID = *proposal.RootID
			}
			root, rootErr := resolveWorkspaceRoot(sqlDB, request.WorkspaceID, rootID, "")
			if rootErr != nil {
				jsonError(w, rootErr.Error(), http.StatusNotFound)
				return
			}
			deltaBaselineAt = time.Now().UnixMilli()
			deltaRootID = root.ID
			if _, snapshotErr := s.saveDeltaSnapshotForRoot(sqlDB, root, deltaBaselineAt); snapshotErr != nil {
				jsonError(w, snapshotErr.Error(), http.StatusInternalServerError)
				return
			}
			if watermarkErr := db.SetDeltaReviewedAtForRoot(
				sqlDB, request.WorkspaceID, root.ID, deltaBaselineAt,
			); watermarkErr != nil {
				jsonError(w, watermarkErr.Error(), http.StatusInternalServerError)
				return
			}
		}
		s.hub.Broadcast("architecture:proposal", map[string]any{"workspaceId": request.WorkspaceID, "proposalId": proposalID, "finalized": true})
		s.hub.BroadcastSnapshot(snapshot)
		if deltaBaselineAt > 0 {
			s.hub.Broadcast("delta:ready", map[string]any{
				"workspaceId": request.WorkspaceID,
				"rootId":      deltaRootID,
				"baselineAt":  deltaBaselineAt,
			})
		}
		jsonOK(w, map[string]any{
			"proposal":        proposal,
			"snapshot":        snapshot,
			"deltaBaselineAt": deltaBaselineAt,
		})
		return
	}
	if r.Method == http.MethodPost && len(parts) == 4 && parts[1] == "systems" && parts[3] == "decision" {
		var request decideArchitectureProposalSystemRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			jsonError(w, "bad request", http.StatusBadRequest)
			return
		}
		sqlDB, err := s.dbFor(request.WorkspaceID)
		if err != nil {
			jsonError(w, err.Error(), http.StatusNotFound)
			return
		}
		candidate, err := db.DecideArchitectureProposalSystem(sqlDB, proposalID, request.WorkspaceID, parts[2], request.Revision, db.ArchitectureProposalDecision{Decision: request.Decision, RejectionReason: request.RejectionReason, DecidedBy: request.DecidedBy})
		if err != nil {
			jsonError(w, err.Error(), proposalErrorStatus(err))
			return
		}
		s.hub.Broadcast("architecture:proposal", map[string]any{"workspaceId": request.WorkspaceID, "proposalId": proposalID, "systemKey": parts[2], "decision": candidate.Decision})
		if candidate.Decision == db.ProposalDecisionApproved {
			if snapshot, snapshotErr := db.GetCanvasSnapshot(sqlDB, request.WorkspaceID); snapshotErr == nil {
				s.hub.BroadcastSnapshot(snapshot)
			}
		}
		jsonOK(w, candidate)
		return
	}
	http.NotFound(w, r)
}
