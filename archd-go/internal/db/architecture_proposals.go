package db

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	ProposalDecisionPending  = "pending"
	ProposalDecisionApproved = "approved"
	ProposalDecisionRejected = "rejected"
)

type ArchitectureProposal struct {
	ID              string                    `json:"id"`
	WorkspaceID     string                    `json:"workspaceId"`
	RootID          *string                   `json:"rootId"`
	ParentScopeType string                    `json:"parentScopeType"`
	ParentScopeID   string                    `json:"parentScopeId"`
	CurrentRevision int                       `json:"currentRevision"`
	CreatedBy       string                    `json:"createdBy"`
	CreatedAt       int64                     `json:"createdAt"`
	UpdatedAt       int64                     `json:"updatedAt"`
	Round           ArchitectureProposalRound `json:"round"`
}

type ArchitectureProposalRound struct {
	Revision        int                              `json:"revision"`
	Rationale       string                           `json:"rationale"`
	EvidenceSummary string                           `json:"evidenceSummary"`
	Coverage        string                           `json:"coverage"`
	CreatedBy       string                           `json:"createdBy"`
	CreatedAt       int64                            `json:"createdAt"`
	Systems         []ArchitectureProposalSystem     `json:"systems"`
	Memberships     []ArchitectureProposalMembership `json:"memberships"`
}

type ArchitectureProposalSystem struct {
	SystemKey            string  `json:"systemKey"`
	Name                 string  `json:"name"`
	Description          string  `json:"description"`
	ParentRefType        string  `json:"parentRefType"`
	ParentRefID          string  `json:"parentRefId"`
	Depth                int     `json:"depth"`
	Decision             string  `json:"decision"`
	RejectionReason      string  `json:"rejectionReason"`
	DecidedBy            string  `json:"decidedBy"`
	DecidedAt            *int64  `json:"decidedAt"`
	MaterializedSystemID *string `json:"materializedSystemId"`
	FileCount            int     `json:"fileCount"`
	AffectedFileCount    int     `json:"affectedFileCount"`
}

type ArchitectureProposalMembership struct {
	ID              string  `json:"id"`
	FileID          *string `json:"fileId"`
	RootID          string  `json:"rootId"`
	FilePath        string  `json:"filePath"`
	TargetSystemKey string  `json:"targetSystemKey"`
	Disposition     string  `json:"disposition"`
	Rationale       string  `json:"rationale"`
}

type ArchitectureProposalDecision struct {
	Decision        string `json:"decision"`
	RejectionReason string `json:"rejectionReason"`
	DecidedBy       string `json:"decidedBy"`
}

func validateProposalRound(round *ArchitectureProposalRound) error {
	if round.Coverage != "complete" && round.Coverage != "partial" && round.Coverage != "no_change" {
		return fmt.Errorf("invalid coverage %q", round.Coverage)
	}
	keys := make(map[string]ArchitectureProposalSystem, len(round.Systems))
	for i := range round.Systems {
		system := &round.Systems[i]
		if strings.TrimSpace(system.Name) == "" {
			return fmt.Errorf("proposal system name is required")
		}
		if system.SystemKey == "" {
			system.SystemKey = uuid.NewString()
		}
		if _, duplicate := keys[system.SystemKey]; duplicate {
			return fmt.Errorf("duplicate proposal system %s", system.SystemKey)
		}
		if system.ParentRefType != "scope" && system.ParentRefType != "live_system" && system.ParentRefType != "proposed_system" {
			return fmt.Errorf("invalid parent reference %q", system.ParentRefType)
		}
		if system.ParentRefType != "scope" && system.ParentRefID == "" {
			return fmt.Errorf("parent reference id is required")
		}
		system.Decision = ProposalDecisionPending
		system.RejectionReason = ""
		system.DecidedBy = ""
		system.DecidedAt = nil
		system.MaterializedSystemID = nil
		keys[system.SystemKey] = *system
	}
	for _, system := range round.Systems {
		if system.ParentRefType == "proposed_system" {
			if _, exists := keys[system.ParentRefID]; !exists {
				return fmt.Errorf("proposed parent %s does not exist", system.ParentRefID)
			}
			if keys[system.ParentRefID].Depth >= system.Depth {
				return fmt.Errorf("proposal depth must increase below parent %s", system.ParentRefID)
			}
		}
	}
	seenFiles := make(map[string]bool, len(round.Memberships))
	for i := range round.Memberships {
		membership := &round.Memberships[i]
		if membership.ID == "" {
			membership.ID = uuid.NewString()
		}
		if strings.TrimSpace(membership.FilePath) == "" || seenFiles[membership.FilePath] {
			return fmt.Errorf("each membership needs a unique file path")
		}
		seenFiles[membership.FilePath] = true
		switch membership.Disposition {
		case "assign":
			if keys[membership.TargetSystemKey].SystemKey == "" {
				return fmt.Errorf("assign membership needs a proposed system")
			}
		case "retain", "unassigned", "excluded":
		default:
			return fmt.Errorf("invalid membership disposition %q", membership.Disposition)
		}
	}
	return nil
}

func CreateArchitectureProposal(database *sql.DB, proposal ArchitectureProposal) (*ArchitectureProposal, error) {
	if proposal.WorkspaceID == "" {
		return nil, fmt.Errorf("workspace id is required")
	}
	if proposal.ParentScopeType == "" {
		proposal.ParentScopeType = "workspace"
	}
	if proposal.ParentScopeType != "workspace" && proposal.ParentScopeType != "system" {
		return nil, fmt.Errorf("invalid parent scope %q", proposal.ParentScopeType)
	}
	if proposal.ParentScopeType == "system" && proposal.ParentScopeID == "" {
		return nil, fmt.Errorf("system parent scope requires an id")
	}
	if err := validateProposalRound(&proposal.Round); err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	if proposal.ID == "" {
		proposal.ID = uuid.NewString()
	}
	if proposal.CreatedBy == "" {
		proposal.CreatedBy = "agent"
	}
	proposal.CurrentRevision = 1
	proposal.CreatedAt, proposal.UpdatedAt = now, now
	proposal.Round.Revision = 1
	proposal.Round.CreatedAt = now
	if proposal.Round.CreatedBy == "" {
		proposal.Round.CreatedBy = proposal.CreatedBy
	}
	tx, err := database.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	var exists int
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=?)`, proposal.WorkspaceID).Scan(&exists); err != nil || exists == 0 {
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("workspace %s does not exist", proposal.WorkspaceID)
	}
	if proposal.RootID != nil {
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM roots WHERE id=? AND workspace_id=?)`, *proposal.RootID, proposal.WorkspaceID).Scan(&exists); err != nil || exists == 0 {
			if err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("proposal root does not belong to workspace")
		}
	}
	if proposal.ParentScopeType == "system" {
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM systems WHERE id=? AND workspace_id=?)`, proposal.ParentScopeID, proposal.WorkspaceID).Scan(&exists); err != nil || exists == 0 {
			if err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("proposal parent does not belong to workspace")
		}
	}
	if _, err := tx.Exec(`INSERT INTO architecture_proposals(id,workspace_id,root_id,parent_scope_type,parent_scope_id,current_revision,created_by,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?)`, proposal.ID, proposal.WorkspaceID, proposal.RootID, proposal.ParentScopeType, proposal.ParentScopeID, proposal.CreatedBy, now, now); err != nil {
		return nil, err
	}
	if err := insertProposalRound(tx, proposal.ID, &proposal.Round); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &proposal, nil
}

func insertProposalRound(tx *sql.Tx, proposalID string, round *ArchitectureProposalRound) error {
	var workspaceID string
	var proposalRootID *string
	if err := tx.QueryRow(`SELECT workspace_id,root_id FROM architecture_proposals WHERE id=?`, proposalID).Scan(&workspaceID, &proposalRootID); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO architecture_proposal_rounds(proposal_id,revision,rationale,evidence_summary,coverage,created_by,created_at) VALUES(?,?,?,?,?,?,?)`, proposalID, round.Revision, round.Rationale, round.EvidenceSummary, round.Coverage, round.CreatedBy, round.CreatedAt); err != nil {
		return err
	}
	for _, system := range round.Systems {
		if _, err := tx.Exec(`INSERT INTO architecture_proposal_systems(proposal_id,revision,system_key,name,description,parent_ref_type,parent_ref_id,depth) VALUES(?,?,?,?,?,?,?,?)`, proposalID, round.Revision, system.SystemKey, system.Name, system.Description, system.ParentRefType, system.ParentRefID, system.Depth); err != nil {
			return err
		}
	}
	for i := range round.Memberships {
		membership := &round.Memberships[i]
		var currentRoot, currentPath string
		switch {
		case membership.FileID != nil:
			if err := tx.QueryRow(`SELECT f.root_id,f.rel_path FROM files f JOIN roots r ON r.id=f.root_id WHERE f.id=? AND r.workspace_id=?`, *membership.FileID, workspaceID).Scan(&currentRoot, &currentPath); err != nil {
				return fmt.Errorf("membership file %s is stale: %w", membership.FilePath, err)
			}
		case membership.Disposition == "assign" || membership.Disposition == "retain":
			if proposalRootID != nil {
				if err := tx.QueryRow(`SELECT id,root_id,rel_path FROM files WHERE root_id=? AND rel_path=?`, *proposalRootID, membership.FilePath).Scan(&membership.FileID, &currentRoot, &currentPath); err != nil {
					return fmt.Errorf("membership path %s does not resolve in proposal root: %w", membership.FilePath, err)
				}
			} else {
				rows, err := tx.Query(`SELECT f.id,f.root_id,f.rel_path FROM files f JOIN roots r ON r.id=f.root_id WHERE r.workspace_id=? AND f.rel_path=?`, workspaceID, membership.FilePath)
				if err != nil {
					return err
				}
				matches := 0
				for rows.Next() {
					matches++
					if err := rows.Scan(&membership.FileID, &currentRoot, &currentPath); err != nil {
						rows.Close()
						return err
					}
				}
				if err := rows.Close(); err != nil {
					return err
				}
				if matches != 1 {
					return fmt.Errorf("membership path %s resolved to %d files; provide rootId", membership.FilePath, matches)
				}
			}
		}
		if currentRoot != "" {
			if membership.RootID != "" && membership.RootID != currentRoot {
				return fmt.Errorf("membership path %s belongs to a different root", membership.FilePath)
			}
			membership.RootID = currentRoot
			membership.FilePath = currentPath
		}
		if _, err := tx.Exec(`INSERT INTO architecture_proposal_memberships(id,proposal_id,revision,file_id,root_id,file_path,target_system_key,disposition,rationale) VALUES(?,?,?,?,?,?,?,?,?)`, membership.ID, proposalID, round.Revision, membership.FileID, membership.RootID, membership.FilePath, membership.TargetSystemKey, membership.Disposition, membership.Rationale); err != nil {
			return err
		}
	}
	return nil
}

func AddArchitectureProposalRevision(database *sql.DB, proposalID, workspaceID string, expectedRevision int, round ArchitectureProposalRound) (*ArchitectureProposal, error) {
	if err := validateProposalRound(&round); err != nil {
		return nil, err
	}
	tx, err := database.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	var current int
	if err := tx.QueryRow(`SELECT current_revision FROM architecture_proposals WHERE id=? AND workspace_id=?`, proposalID, workspaceID).Scan(&current); err != nil {
		return nil, err
	}
	if current != expectedRevision {
		return nil, fmt.Errorf("stale proposal revision: current=%d", current)
	}
	round.Revision = current + 1
	round.CreatedAt = time.Now().UnixMilli()
	if round.CreatedBy == "" {
		round.CreatedBy = "agent"
	}
	if err := insertProposalRound(tx, proposalID, &round); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`UPDATE architecture_proposals SET current_revision=?,updated_at=? WHERE id=?`, round.Revision, round.CreatedAt, proposalID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return GetArchitectureProposal(database, proposalID, workspaceID, false)
}

func DecideArchitectureProposalSystem(database *sql.DB, proposalID, workspaceID, systemKey string, revision int, decision ArchitectureProposalDecision) (*ArchitectureProposalSystem, error) {
	if decision.Decision != ProposalDecisionApproved && decision.Decision != ProposalDecisionRejected {
		return nil, fmt.Errorf("invalid decision %q", decision.Decision)
	}
	if decision.Decision == ProposalDecisionRejected && strings.TrimSpace(decision.RejectionReason) == "" {
		return nil, fmt.Errorf("rejection reason is required")
	}
	if decision.DecidedBy == "" {
		decision.DecidedBy = "user"
	}
	tx, err := database.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	var current int
	if err := tx.QueryRow(`SELECT current_revision FROM architecture_proposals WHERE id=? AND workspace_id=?`, proposalID, workspaceID).Scan(&current); err != nil {
		return nil, err
	}
	if current != revision {
		return nil, fmt.Errorf("stale proposal revision: current=%d", current)
	}
	var system ArchitectureProposalSystem
	if err := tx.QueryRow(`SELECT system_key,name,description,parent_ref_type,parent_ref_id,depth,decision,rejection_reason,materialized_system_id FROM architecture_proposal_systems WHERE proposal_id=? AND revision=? AND system_key=?`, proposalID, revision, systemKey).Scan(&system.SystemKey, &system.Name, &system.Description, &system.ParentRefType, &system.ParentRefID, &system.Depth, &system.Decision, &system.RejectionReason, &system.MaterializedSystemID); err != nil {
		return nil, err
	}
	if system.Decision != ProposalDecisionPending {
		if system.Decision == decision.Decision {
			return &system, tx.Commit()
		}
		return nil, fmt.Errorf("proposal system already %s", system.Decision)
	}
	now := time.Now().UnixMilli()
	if decision.Decision == ProposalDecisionRejected {
		if _, err := tx.Exec(`UPDATE architecture_proposal_systems SET decision='rejected',rejection_reason=?,decided_by=?,decided_at=? WHERE proposal_id=? AND revision=? AND system_key=? AND decision='pending'`, decision.RejectionReason, decision.DecidedBy, now, proposalID, revision, systemKey); err != nil {
			return nil, err
		}
	} else {
		var parentID *string
		switch system.ParentRefType {
		case "scope":
			var scopeType, scopeID string
			if err := tx.QueryRow(`SELECT parent_scope_type,parent_scope_id FROM architecture_proposals WHERE id=?`, proposalID).Scan(&scopeType, &scopeID); err != nil {
				return nil, err
			}
			if scopeType == "system" {
				parentID = &scopeID
			}
		case "live_system":
			parentID = &system.ParentRefID
		case "proposed_system":
			if err := tx.QueryRow(`SELECT materialized_system_id FROM architecture_proposal_systems WHERE proposal_id=? AND revision=? AND system_key=? AND decision='approved'`, proposalID, revision, system.ParentRefID).Scan(&parentID); err != nil || parentID == nil {
				return nil, fmt.Errorf("proposed parent %s must be approved first", system.ParentRefID)
			}
		}
		materializedID := uuid.NewString()
		if _, err := tx.Exec(`INSERT INTO systems(id,workspace_id,name,parent_id,source,description,depth,created_at,updated_at) VALUES(?,?,?,?,'agent',?,?,?,?)`, materializedID, workspaceID, system.Name, parentID, system.Description, system.Depth, now, now); err != nil {
			return nil, err
		}
		rows, err := tx.Query(`SELECT file_id,root_id,file_path FROM architecture_proposal_memberships WHERE proposal_id=? AND revision=? AND target_system_key=? AND disposition='assign'`, proposalID, revision, systemKey)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var fileID *string
			var rootID, path string
			if err := rows.Scan(&fileID, &rootID, &path); err != nil {
				rows.Close()
				return nil, err
			}
			if fileID == nil {
				rows.Close()
				return nil, fmt.Errorf("membership %s no longer resolves to a file", path)
			}
			result, err := tx.Exec(`UPDATE files SET system_id=? WHERE id=? AND root_id=?`, materializedID, *fileID, rootID)
			if err != nil {
				rows.Close()
				return nil, err
			}
			if affected, _ := result.RowsAffected(); affected != 1 {
				rows.Close()
				return nil, fmt.Errorf("membership %s is stale", path)
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(`UPDATE architecture_proposal_systems SET decision='approved',materialized_system_id=?,decided_by=?,decided_at=? WHERE proposal_id=? AND revision=? AND system_key=? AND decision='pending'`, materializedID, decision.DecidedBy, now, proposalID, revision, systemKey); err != nil {
			return nil, err
		}
		system.MaterializedSystemID = &materializedID
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	proposal, err := GetArchitectureProposal(database, proposalID, workspaceID, false)
	if err != nil {
		return nil, err
	}
	for _, candidate := range proposal.Round.Systems {
		if candidate.SystemKey == systemKey {
			return &candidate, nil
		}
	}
	return nil, sql.ErrNoRows
}

func GetArchitectureProposal(database *sql.DB, proposalID, workspaceID string, includeRetained bool) (*ArchitectureProposal, error) {
	proposal := &ArchitectureProposal{ID: proposalID, WorkspaceID: workspaceID}
	if err := database.QueryRow(`SELECT root_id,parent_scope_type,parent_scope_id,current_revision,created_by,created_at,updated_at FROM architecture_proposals WHERE id=? AND workspace_id=?`, proposalID, workspaceID).Scan(&proposal.RootID, &proposal.ParentScopeType, &proposal.ParentScopeID, &proposal.CurrentRevision, &proposal.CreatedBy, &proposal.CreatedAt, &proposal.UpdatedAt); err != nil {
		return nil, err
	}
	round := &proposal.Round
	if err := database.QueryRow(`SELECT revision,rationale,evidence_summary,coverage,created_by,created_at FROM architecture_proposal_rounds WHERE proposal_id=? AND revision=?`, proposalID, proposal.CurrentRevision).Scan(&round.Revision, &round.Rationale, &round.EvidenceSummary, &round.Coverage, &round.CreatedBy, &round.CreatedAt); err != nil {
		return nil, err
	}
	rows, err := database.Query(`SELECT s.system_key,s.name,s.description,s.parent_ref_type,s.parent_ref_id,s.depth,s.decision,s.rejection_reason,s.decided_by,s.decided_at,s.materialized_system_id,COUNT(CASE WHEN m.disposition='assign' THEN 1 END),COUNT(CASE WHEN m.disposition!='retain' THEN 1 END) FROM architecture_proposal_systems s LEFT JOIN architecture_proposal_memberships m ON m.proposal_id=s.proposal_id AND m.revision=s.revision AND m.target_system_key=s.system_key WHERE s.proposal_id=? AND s.revision=? GROUP BY s.system_key ORDER BY s.depth,s.name`, proposalID, round.Revision)
	if err != nil {
		return nil, err
	}
	round.Systems = make([]ArchitectureProposalSystem, 0)
	for rows.Next() {
		var system ArchitectureProposalSystem
		if err := rows.Scan(&system.SystemKey, &system.Name, &system.Description, &system.ParentRefType, &system.ParentRefID, &system.Depth, &system.Decision, &system.RejectionReason, &system.DecidedBy, &system.DecidedAt, &system.MaterializedSystemID, &system.FileCount, &system.AffectedFileCount); err != nil {
			rows.Close()
			return nil, err
		}
		round.Systems = append(round.Systems, system)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	membershipSQL := `SELECT id,file_id,root_id,file_path,target_system_key,disposition,rationale FROM architecture_proposal_memberships WHERE proposal_id=? AND revision=?`
	if !includeRetained {
		membershipSQL += ` AND disposition!='retain'`
	}
	membershipSQL += ` ORDER BY file_path`
	rows, err = database.Query(membershipSQL, proposalID, round.Revision)
	if err != nil {
		return nil, err
	}
	round.Memberships = make([]ArchitectureProposalMembership, 0)
	for rows.Next() {
		var membership ArchitectureProposalMembership
		if err := rows.Scan(&membership.ID, &membership.FileID, &membership.RootID, &membership.FilePath, &membership.TargetSystemKey, &membership.Disposition, &membership.Rationale); err != nil {
			rows.Close()
			return nil, err
		}
		round.Memberships = append(round.Memberships, membership)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	return proposal, rows.Close()
}

func ListArchitectureProposals(database *sql.DB, workspaceID string) ([]ArchitectureProposal, error) {
	rows, err := database.Query(`SELECT id FROM architecture_proposals WHERE workspace_id=? ORDER BY updated_at DESC`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := make([]ArchitectureProposal, 0, len(ids))
	for _, id := range ids {
		proposal, err := GetArchitectureProposal(database, id, workspaceID, false)
		if err != nil {
			return nil, err
		}
		proposal.Round.Memberships = []ArchitectureProposalMembership{}
		result = append(result, *proposal)
	}
	return result, nil
}
